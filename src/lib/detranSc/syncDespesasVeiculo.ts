import { sincronizarParceiroDespesa, type GravarParceiroDespesaResult } from "../parceiroDespesasDb.js";
import { formatPlacaHyphen } from "../placa.js";
import { consultarVeiculoDetranSc, consultarVeiculoDetranScPorTicket } from "./consulta.js";
import {
  extrairDespesasDetranSc,
  type DetranDespesaNormalizada,
} from "./mapDebitosProprietario.js";
import {
  loadVeiculosParaSync,
  type VeiculoFrota,
} from "./syncVeiculo.js";

export type SyncDespesasResult = {
  placa: string;
  novos: number;
  atualizados: number;
  semAlteracao: number;
  ignorados: number;
  avisos: string[];
};

function aplicarDespesa(
  placa: string,
  d: DetranDespesaNormalizada,
  dryRun: boolean,
): GravarParceiroDespesaResult | null {
  if (dryRun) {
    return {
      registro: {
        id: "(dry-run)",
        veiculoId: null,
        placa: formatPlacaHyphen(placa),
        categoria: d.categoria,
        descricao: d.descricao,
        data: d.data,
        valor: d.valor,
        competencia: d.competencia,
        origem: d.origem,
      },
      aviso: null,
      acao: "novo",
    };
  }

  return sincronizarParceiroDespesa({
    placa,
    categoria: d.categoria,
    descricao: d.descricao,
    data: d.data,
    valor: d.valor,
    competencia: d.competencia,
    origem: d.origem,
  });
}

export function processarDespesasDetranSc(
  placa: string,
  raw: unknown,
  opts?: { dryRun?: boolean },
): SyncDespesasResult {
  const { despesas, ignorados } = extrairDespesasDetranSc(placa, raw);
  const result: SyncDespesasResult = {
    placa: formatPlacaHyphen(placa),
    novos: 0,
    atualizados: 0,
    semAlteracao: 0,
    ignorados,
    avisos: [],
  };

  for (const d of despesas) {
    const r = aplicarDespesa(placa, d, opts?.dryRun === true);
    if (!r) continue;
    if (r.acao === "novo") result.novos++;
    else if (r.acao === "atualizado") result.atualizados++;
    else result.semAlteracao++;
    if (r.aviso) result.avisos.push(`${d.categoria} ${d.exercicio || d.data}: ${r.aviso}`);
  }

  return result;
}

export async function sincronizarDespesasVeiculoDetranSc(
  placa: string,
  renavam: string,
  opts?: { dryRun?: boolean; captcha?: string },
): Promise<SyncDespesasResult> {
  const raw = await consultarVeiculoDetranSc(placa, renavam, { captcha: opts?.captcha });
  return processarDespesasDetranSc(placa, raw, opts);
}

export async function sincronizarDespesasPorTicketDetranSc(
  placa: string,
  ticket: string,
  opts?: { dryRun?: boolean },
): Promise<SyncDespesasResult> {
  const raw = await consultarVeiculoDetranScPorTicket(ticket);
  return processarDespesasDetranSc(placa, raw, opts);
}

export async function sincronizarDespesasFrotaDetranSc(opts?: {
  placa?: string;
  dryRun?: boolean;
  delayMs?: number;
}): Promise<SyncDespesasResult[]> {
  const veiculos = loadVeiculosParaSync(opts?.placa);
  const out: SyncDespesasResult[] = [];
  const delay = opts?.delayMs ?? 1500;

  for (let i = 0; i < veiculos.length; i++) {
    const v = veiculos[i]!;
    try {
      const r = await sincronizarDespesasVeiculoDetranSc(v.placa, v.renavam, {
        dryRun: opts?.dryRun,
      });
      out.push(r);
    } catch (e) {
      out.push({
        placa: formatPlacaHyphen(v.placa),
        novos: 0,
        atualizados: 0,
        semAlteracao: 0,
        ignorados: 0,
        avisos: [e instanceof Error ? e.message : String(e)],
      });
    }
    if (i < veiculos.length - 1) {
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return out;
}

export type { VeiculoFrota };
