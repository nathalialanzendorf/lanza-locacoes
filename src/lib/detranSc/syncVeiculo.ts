import fs from "node:fs";
import path from "node:path";

import { formatPlacaHyphen } from "../placa.js";
import { REPO_ROOT } from "../repoRoot.js";
import {
  sincronizarClienteDespesa,
  type SincronizarClienteDespesaResult,
} from "../clienteDespesasDb.js";
import { consultarVeiculoDetranSc, consultarVeiculoDetranScPorTicket } from "./consulta.js";
import { extrairMultasDetranSc } from "./mapInfracoes.js";
import type { DetranScMultaNormalizada } from "./types.js";

export type VeiculoFrota = {
  placa: string;
  renavam: string;
};

export type SyncVeiculoResult = {
  placa: string;
  novos: number;
  atualizados: number;
  semAlteracao: number;
  historico: number;
  debitosIgnoradosProprietario: number;
  /** Infrações sem data de autuação (precisam de revisão manual). */
  revisarManual: number;
  avisos: string[];
};

function loadVeiculosFrota(placaFiltro?: string): VeiculoFrota[] {
  const p = path.join(REPO_ROOT, "database", "veiculos.json");
  const j = JSON.parse(fs.readFileSync(p, "utf8")) as {
    veiculos?: { placa?: string; renavam?: string; ativo?: boolean; ufRegistro?: string }[];
  };
  const filtro = placaFiltro ? formatPlacaHyphen(placaFiltro) : null;

  return (j.veiculos ?? [])
    // Sync atualiza apenas veículos ATIVOS (sync-veiculo/cliente é que tratam inativos).
    .filter((v) => v.ativo !== false)
    // DETRAN SC só tem dados de veículos registrados em SC — pular outras UFs.
    .filter((v) => !v.ufRegistro || v.ufRegistro.toUpperCase() === "SC")
    .filter((v) => v.placa && v.renavam)
    .filter((v) => !filtro || formatPlacaHyphen(v.placa!) === filtro)
    .map((v) => ({ placa: v.placa!, renavam: String(v.renavam!) }));
}

function aplicarMulta(
  placa: string,
  m: DetranScMultaNormalizada,
  opts?: { dryRun?: boolean; prazoDias?: number },
): SincronizarClienteDespesaResult | null {
  if (opts?.dryRun === true) {
    return {
      registro: {
        id: "(dry-run)",
        veiculoId: formatPlacaHyphen(placa),
        autoInfracao: m.autoInfracao,
        descricao: m.descricao,
        localInfracao: m.localInfracao,
        dataAutuacao: m.dataAutuacao,
        valorMulta: m.valorMulta,
        situacao: m.situacao,
        limiteDefesa: m.limiteDefesa,
        condutorId: null,
        condutorConfirmado: m.quitadaDetran === true,
        condutorContrato: null,
        quitadaDetran: m.quitadaDetran,
        cadastradoEm: "",
        atualizadoEm: "",
        origem: "detran-sc",
      },
      acao: "novo",
      aviso: null,
    };
  }

  return sincronizarClienteDespesa(
    placa,
    {
      autoInfracao: m.autoInfracao,
      descricao: m.descricao,
      localInfracao: m.localInfracao,
      dataAutuacao: m.dataAutuacao,
      valorMulta: m.valorMulta,
      situacao: m.situacao,
      limiteDefesa: m.limiteDefesa,
      quitadaDetran: m.quitadaDetran,
      categoria: "Infração",
      origem: "detran-sc",
    },
    { fonteDetran: m.fonte, prazoDias: opts?.prazoDias },
  );
}

export async function sincronizarMultasVeiculoDetranSc(
  placa: string,
  renavam: string,
  opts?: { dryRun?: boolean; prazoDias?: number; captcha?: string },
): Promise<SyncVeiculoResult> {
  const raw = await consultarVeiculoDetranSc(placa, renavam, { captcha: opts?.captcha });
  return processarRespostaDetranSc(placa, raw, opts);
}

export async function sincronizarMultasPorTicketDetranSc(
  placa: string,
  ticket: string,
  opts?: { dryRun?: boolean; prazoDias?: number },
): Promise<SyncVeiculoResult> {
  const raw = await consultarVeiculoDetranScPorTicket(ticket);
  return processarRespostaDetranSc(placa, raw, opts);
}

export function processarRespostaDetranSc(
  placa: string,
  raw: unknown,
  opts?: { dryRun?: boolean; prazoDias?: number },
): SyncVeiculoResult {
  const { cobraveis, historico, debitosIgnoradosProprietario } =
    extrairMultasDetranSc(raw);

  const result: SyncVeiculoResult = {
    placa: formatPlacaHyphen(placa),
    novos: 0,
    atualizados: 0,
    semAlteracao: 0,
    historico: 0,
    debitosIgnoradosProprietario,
    revisarManual: 0,
    avisos: [],
  };

  const all = [...cobraveis, ...historico];

  for (const m of all) {
    const r = aplicarMulta(placa, m, opts);
    if (!r) continue;

    if (m.quitadaDetran) result.historico++;
    if (r.registro.revisarManual) result.revisarManual++;

    if (r.acao === "novo") result.novos++;
    else if (r.acao === "atualizado") result.atualizados++;
    else result.semAlteracao++;

    if (r.aviso) result.avisos.push(`${m.autoInfracao}: ${r.aviso}`);
  }

  return result;
}

export function loadVeiculosParaSync(placaFiltro?: string): VeiculoFrota[] {
  const list = loadVeiculosFrota(placaFiltro);
  if (placaFiltro && list.length === 0) {
    throw new Error(`Placa não encontrada em veiculos.json: ${placaFiltro}`);
  }
  return list;
}

export async function sincronizarMultasFrotaDetranSc(opts?: {
  placa?: string;
  dryRun?: boolean;
  prazoDias?: number;
  delayMs?: number;
}): Promise<SyncVeiculoResult[]> {
  const veiculos = loadVeiculosParaSync(opts?.placa);
  const out: SyncVeiculoResult[] = [];
  const delay = opts?.delayMs ?? 1500;

  for (let i = 0; i < veiculos.length; i++) {
    const v = veiculos[i]!;
    try {
      const r = await sincronizarMultasVeiculoDetranSc(v.placa, v.renavam, {
        dryRun: opts?.dryRun,
        prazoDias: opts?.prazoDias,
      });
      out.push(r);
    } catch (e) {
      out.push({
        placa: formatPlacaHyphen(v.placa),
        novos: 0,
        atualizados: 0,
        semAlteracao: 0,
        historico: 0,
        debitosIgnoradosProprietario: 0,
        revisarManual: 0,
        avisos: [e instanceof Error ? e.message : String(e)],
      });
    }
    if (i < veiculos.length - 1) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return out;
}
