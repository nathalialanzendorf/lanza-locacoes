import { compactPlaca } from "../placa.js";
import type { DetranDespesaNormalizada } from "../detranSc/mapDebitosProprietario.js";
import type { DetranRsConsultaVeiculo } from "./consulta.js";

function parseValor(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v * 100) / 100;
  const s = String(v ?? "")
    .replace(/R\$\s*/i, "")
    .trim();
  if (!s) return 0;
  const n = s.includes(",")
    ? parseFloat(s.replace(/\./g, "").replace(",", "."))
    : parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/** "Data limite para pagamento: 31/07/2026" → "31/07/2026". */
function extrairDataBr(s: unknown): string {
  const m = String(s ?? "").match(/(\d{2}\/\d{2}\/\d{4})/);
  return m?.[1] ?? "";
}

function competenciaDeData(data: string, exercicio: string): string {
  const m = data.match(/^\d{2}\/(\d{2})\/(\d{4})/);
  if (m) return `${m[1]}/${m[2]}`;
  return exercicio ? `12/${exercicio}` : "";
}

const PAGO_RE = /liquidad|conclu|pago|quitad|baixad/i;

function slug(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Extrai IPVA (imposto.historico em aberto) e Licenciamento
 * (expedicaoDocumento.vlrLic) do payload do DETRAN RS.
 *
 * Só inclui débitos EM ABERTO — exercícios já liquidados/concluídos são ignorados.
 * Tal como no SC, cada forma do IPVA (cota única / parcela) vira uma despesa
 * distinta (origem única), e a escolha de qual cobrar fica no relatório.
 */
export function extrairDespesasDetranRs(
  placa: string,
  raw: DetranRsConsultaVeiculo,
): { despesas: DetranDespesaNormalizada[]; ignorados: number } {
  const placaKey = compactPlaca(placa);
  const despesas: DetranDespesaNormalizada[] = [];
  const seen = new Set<string>();
  let ignorados = 0;

  const push = (d: DetranDespesaNormalizada): void => {
    if (d.valor <= 0 || seen.has(d.origem)) return;
    seen.add(d.origem);
    despesas.push(d);
  };

  // IPVA — imposto.historico[]
  const imposto = raw.imposto as
    | { historico?: Array<Record<string, unknown>> }
    | undefined;
  for (const ano of imposto?.historico ?? []) {
    const exercicio = String(ano.exercicio ?? "").replace(/\D/g, "").slice(0, 4);
    const situacao = String(ano.situacao ?? "");
    const data = extrairDataBr(ano.dataVencimento) || (exercicio ? `30/04/${exercicio}` : "");
    const competencia = competenciaDeData(data, exercicio);
    const debitos = Array.isArray(ano.debitos)
      ? (ano.debitos as Array<Record<string, unknown>>)
      : [];

    // Em aberto = situação não-paga E com débitos detalhados (cota/parcela).
    if (PAGO_RE.test(situacao) || debitos.length === 0) {
      ignorados++;
      continue;
    }

    for (const deb of debitos) {
      if (deb.dataPagamento) continue; // parcela já paga
      const forma = String(deb.descricao ?? "Cota Única").trim();
      const valor = parseValor(deb.valorTotalComDesconto ?? deb.valorOriginal);
      push({
        categoria: "IPVA",
        descricao: `IPVA ${forma}${exercicio ? ` (${exercicio})` : ""}`,
        data,
        valor,
        competencia,
        origem: `detran-rs/debitos/${placaKey}/IPVA/${exercicio}-${slug(forma)}`,
        exercicio,
      });
    }
  }

  // Licenciamento — expedicaoDocumento.vlrLic (taxa do exercício de referência)
  const exped = raw.expedicaoDocumento as Record<string, unknown> | undefined;
  const ident = raw.identificacao as Record<string, unknown> | undefined;
  const vlrLic = parseValor(exped?.vlrLic);
  if (exped && vlrLic > 0) {
    const exercicio = String(exped.exercRefLic ?? ident?.exercLicenciamento ?? "").replace(/\D/g, "").slice(0, 4);
    const data =
      extrairDataBr(exped.txtSitLic) || extrairDataBr(ident?.dtVencLicenciamento) || (exercicio ? `31/12/${exercicio}` : "");
    const competencia = competenciaDeData(data, exercicio);
    push({
      categoria: "Licenciamento",
      descricao: `Licenciamento${exercicio ? ` (${exercicio})` : ""}`,
      data,
      valor: vlrLic,
      competencia,
      origem: `detran-rs/debitos/${placaKey}/Licenciamento/${exercicio}`,
      exercicio,
    });
  }

  return { despesas, ignorados };
}

/** Resumo agregado de infrações do RS (o endpoint não detalha cada multa). */
export type DetranRsInfracaoResumo = {
  qtVencidas: number;
  vlVencidas: string;
  qtAVencer: number;
  vlAVencer: string;
  qtAgPrazoDef: number;
  qtAgPrazoJulg: number;
  qtSuspensas: number;
  total: number;
};

export function extrairInfracoesResumoDetranRs(
  raw: DetranRsConsultaVeiculo,
): DetranRsInfracaoResumo {
  const inf = (raw.infracao as Record<string, unknown> | undefined) ?? {};
  const num = (k: string): number => Number(inf[k] ?? 0) || 0;
  const str = (k: string): string => String(inf[k] ?? "R$ 0,00");
  const total =
    num("qtVencidas") +
    num("qtAVencer") +
    num("qtAgPrazoDef") +
    num("qtAgPrazoJulg") +
    num("qtSuspensas");
  return {
    qtVencidas: num("qtVencidas"),
    vlVencidas: str("vlVencidas"),
    qtAVencer: num("qtAVencer"),
    vlAVencer: str("vlAVencer"),
    qtAgPrazoDef: num("qtAgPrazoDef"),
    qtAgPrazoJulg: num("qtAgPrazoJulg"),
    qtSuspensas: num("qtSuspensas"),
    total,
  };
}
