import fs from "node:fs";
import path from "node:path";

import { sincronizarParceiroDespesa } from "../parceiroDespesasDb.js";
import { compactPlaca, formatPlacaHyphen } from "../placa.js";
import { REPO_ROOT } from "../repoRoot.js";
import { consultarVeiculoDetranRs, type DetranRsConsultaVeiculo } from "./consulta.js";
import {
  extrairDespesasDetranRs,
  extrairInfracoesResumoDetranRs,
} from "./mapDebitos.js";

export type VeiculoFrotaRs = { placa: string; renavam: string };

export type SyncDetranRsResult = {
  placa: string;
  novos: number;
  atualizados: number;
  semAlteracao: number;
  ignorados: number;
  infracoesResumo: number;
  avisos: string[];
};

/** Veículos ATIVOS registrados no RS (ufRegistro === "RS"). */
export function loadVeiculosFrotaRs(placaFiltro?: string): VeiculoFrotaRs[] {
  const p = path.join(REPO_ROOT, "database", "veiculos.json");
  const j = JSON.parse(fs.readFileSync(p, "utf8")) as {
    veiculos?: { placa?: string; renavam?: string; ativo?: boolean; ufRegistro?: string }[];
  };
  const filtro = placaFiltro ? compactPlaca(placaFiltro) : null;

  return (j.veiculos ?? [])
    .filter((v) => v.ativo !== false)
    .filter((v) => String(v.ufRegistro ?? "").toUpperCase() === "RS")
    .filter((v) => v.placa && v.renavam)
    .filter((v) => !filtro || compactPlaca(v.placa!) === filtro)
    .map((v) => ({ placa: v.placa!, renavam: String(v.renavam!) }));
}

export function loadVeiculosRsParaSync(placaFiltro?: string): VeiculoFrotaRs[] {
  const list = loadVeiculosFrotaRs(placaFiltro);
  if (placaFiltro && list.length === 0) {
    throw new Error(
      `Placa RS não encontrada (ufRegistro="RS") em veiculos.json: ${placaFiltro}`,
    );
  }
  return list;
}

export function processarRespostaDetranRs(
  placa: string,
  raw: DetranRsConsultaVeiculo,
  opts?: { dryRun?: boolean },
): SyncDetranRsResult {
  const dryRun = opts?.dryRun === true;
  const { despesas, ignorados } = extrairDespesasDetranRs(placa, raw);
  const resumo = extrairInfracoesResumoDetranRs(raw);

  const result: SyncDetranRsResult = {
    placa: formatPlacaHyphen(placa),
    novos: 0,
    atualizados: 0,
    semAlteracao: 0,
    ignorados,
    infracoesResumo: resumo.total,
    avisos: [],
  };

  for (const d of despesas) {
    if (dryRun) {
      result.novos++;
      continue;
    }
    const r = sincronizarParceiroDespesa({
      placa,
      categoria: d.categoria,
      descricao: d.descricao,
      data: d.data,
      valor: d.valor,
      competencia: d.competencia,
      origem: d.origem,
    });
    if (r.acao === "novo") result.novos++;
    else if (r.acao === "atualizado") result.atualizados++;
    else result.semAlteracao++;
    if (r.aviso) result.avisos.push(`${d.categoria} ${d.exercicio || d.data}: ${r.aviso}`);
  }

  // O endpoint do RS só devolve totais de infração (sem detalhe por multa).
  if (resumo.total > 0) {
    result.avisos.push(
      `Infrações (resumo RS): ${resumo.qtVencidas} vencida(s) ${resumo.vlVencidas}, ` +
        `${resumo.qtAVencer} a vencer ${resumo.vlAVencer} — detalhe por multa não disponível neste endpoint (rever manualmente).`,
    );
  }

  return result;
}

export async function sincronizarVeiculoDetranRs(
  placa: string,
  renavam: string,
  opts?: { dryRun?: boolean },
): Promise<SyncDetranRsResult> {
  const raw = await consultarVeiculoDetranRs(placa, renavam);
  return processarRespostaDetranRs(placa, raw, opts);
}

export async function sincronizarFrotaDetranRs(opts?: {
  placa?: string;
  dryRun?: boolean;
  delayMs?: number;
}): Promise<SyncDetranRsResult[]> {
  const veiculos = loadVeiculosRsParaSync(opts?.placa);
  const out: SyncDetranRsResult[] = [];
  const delay = opts?.delayMs ?? 1500;

  for (let i = 0; i < veiculos.length; i++) {
    const v = veiculos[i]!;
    try {
      out.push(await sincronizarVeiculoDetranRs(v.placa, v.renavam, { dryRun: opts?.dryRun }));
    } catch (e) {
      out.push({
        placa: formatPlacaHyphen(v.placa),
        novos: 0,
        atualizados: 0,
        semAlteracao: 0,
        ignorados: 0,
        infracoesResumo: 0,
        avisos: [e instanceof Error ? e.message : String(e)],
      });
    }
    if (i < veiculos.length - 1) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return out;
}
