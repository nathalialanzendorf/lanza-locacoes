import {
  categoriaInfereCondutor,
  isClienteDespesaAtiva,
  isInfracaoTransito,
  loadClienteDespesasDb,
  resolverCondutorVigencia,
  saveClienteDespesasDb,
} from "./clienteDespesasDb.js";
import { parseDataAutuacao } from "./inferirCondutorInfracao.js";
import { compactPlaca, formatPlacaHyphen } from "./placa.js";

export type ReconAcao =
  | "vinculado"
  | "nao-identificado"
  | "cliente-faltando"
  | "sem-data";

export type ReconItem = {
  autoInfracao: string;
  veiculoId: string;
  dataAutuacao: string;
  valorMulta: number;
  acao: ReconAcao;
  cliente?: string | null;
};

export type ReconResult = {
  total: number;
  vinculados: number;
  naoIdentificados: number;
  clienteFaltando: number;
  semData: number;
  itens: ReconItem[];
};

/**
 * Concilia o condutor das infrações/pedágios **pendentes** (sem condutor e não
 * confirmadas) pela vigência do contrato:
 * - contrato + cliente → vincula e confirma;
 * - sem contrato ativo na data → "Não identificado" (confirmado, sem cliente);
 * - contrato achado mas cliente fora de clientes.json → fica pendente (reporta);
 * - sem data de autuação → fica para revisão manual (reporta).
 *
 * Idempotente: só mexe em registros pendentes. Quitadas são ignoradas.
 */
export function reconciliarCondutores(opts?: {
  dryRun?: boolean;
  placa?: string;
  prazoDias?: number;
  incluirPedagios?: boolean;
}): ReconResult {
  const db = loadClienteDespesasDb();
  const filtro = opts?.placa ? compactPlaca(opts.placa) : null;
  const prazoDias = opts?.prazoDias ?? 90;

  const itens: ReconItem[] = [];
  let mutou = false;

  for (const r of db.clienteDespesas ?? []) {
    if (!isClienteDespesaAtiva(r)) continue;
    // Por padrão só infrações de trânsito; pedágios só com incluirPedagios.
    const elegivel = opts?.incluirPedagios
      ? categoriaInfereCondutor(r.categoria)
      : isInfracaoTransito(r);
    if (!elegivel) continue;
    if (r.quitadaDetran === true) continue;
    if (r.condutorConfirmado === true || r.condutorId) continue;
    if (filtro && compactPlaca(r.veiculoId) !== filtro) continue;

    const base = {
      autoInfracao: r.autoInfracao,
      veiculoId: formatPlacaHyphen(r.veiculoId),
      dataAutuacao: r.dataAutuacao || "(sem data)",
      valorMulta: Number(r.valorMulta) || 0,
    };

    if (!parseDataAutuacao(r.dataAutuacao)) {
      itens.push({ ...base, acao: "sem-data" });
      continue;
    }

    const res = resolverCondutorVigencia(r.veiculoId, r.dataAutuacao, prazoDias);
    if (res.condutorId) {
      if (!opts?.dryRun) {
        r.condutorId = res.condutorId;
        r.condutorContrato = res.condutorContrato;
        r.condutorConfirmado = true;
        r.condutorNaoIdentificado = false;
        r.atualizadoEm = new Date().toISOString();
        mutou = true;
      }
      itens.push({ ...base, acao: "vinculado", cliente: res.aviso ? `${res.aviso}` : null });
      // cliente nome não vem do resolver; guardamos contrato p/ referência
      itens[itens.length - 1]!.cliente = res.condutorContrato;
    } else if (res.naoIdentificado) {
      if (!opts?.dryRun) {
        r.condutorConfirmado = true;
        r.condutorNaoIdentificado = true;
        r.atualizadoEm = new Date().toISOString();
        mutou = true;
      }
      itens.push({ ...base, acao: "nao-identificado" });
    } else {
      // contrato achado, cliente fora de clientes.json → pendente
      if (!opts?.dryRun && r.condutorContrato !== res.condutorContrato) {
        r.condutorContrato = res.condutorContrato;
        r.atualizadoEm = new Date().toISOString();
        mutou = true;
      }
      itens.push({ ...base, acao: "cliente-faltando", cliente: res.condutorContrato });
    }
  }

  if (mutou && !opts?.dryRun) saveClienteDespesasDb(db);

  return {
    total: itens.length,
    vinculados: itens.filter((i) => i.acao === "vinculado").length,
    naoIdentificados: itens.filter((i) => i.acao === "nao-identificado").length,
    clienteFaltando: itens.filter((i) => i.acao === "cliente-faltando").length,
    semData: itens.filter((i) => i.acao === "sem-data").length,
    itens,
  };
}
