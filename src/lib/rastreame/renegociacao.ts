/**
 * Renegociação de débitos no Rastreame (Gastos Gerais).
 */
import {
  fetchAllGastos,
  fetchGastoById,
  postGasto,
  putGasto,
  type GastoRecord,
} from "./gasto.js";

export type ParcelaRenegociacao = {
  /** Número da parcela (a) em axb */
  numero: number;
  /** Total de parcelas (b) em axb */
  totalParcelas: number;
  valor: number;
  /** YYYY-MM-DD ou ISO 8601 */
  data: string;
};

export type RenegociacaoInput = {
  /** Código X em [NEGOCIADO X] */
  negociacaoCodigo: string;
  /** IDs dos gastos existentes a marcar como negociados */
  gastosIds: (number | string)[];
  motoristaKey: string;
  rastreavelKey: string;
  parcelas: ParcelaRenegociacao[];
};

export type ResumoDebito = {
  id: number | string;
  info: string;
  total: number;
  data?: string;
  tipo?: string;
};

function refKey(ref: { key?: string; id?: string | number } | undefined): string {
  return String(ref?.key ?? ref?.id ?? "");
}

/** Converte YYYY-MM-DD → ISO 23:59 America/Recife (02:59 UTC do dia seguinte, padrão Lanza). */
export function dataPagamentoParaIso(data: string): string {
  const t = data.trim();
  if (t.includes("T")) return new Date(t).toISOString();
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Data inválida (use YYYY-MM-DD): ${data}`);
  return new Date(`${m[1]}-${m[2]}-${m[3]}T23:59:00-03:00`).toISOString();
}

export function tagNegociado(codigo: string): string {
  return `[NEGOCIADO ${String(codigo).trim()}]`;
}

/** Remove a tag ATRASADO (em qualquer posição) e normaliza espaços. */
export function removerTagAtrasado(info: string): string {
  return String(info ?? "")
    .replace(/\bATRASADO\b\s*[-–—:]?\s*/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function infoMarcadaNegociada(info: string, codigo: string): string {
  const tag = tagNegociado(codigo);
  const t = String(info ?? "").trim();
  if (t.startsWith("[NEGOCIADO")) return t;
  // Regra Lanza: ao marcar como [NEGOCIADO x], remover a tag ATRASADO.
  return `${tag} ${removerTagAtrasado(t)}`;
}

export function infoParcelaRenegociacao(numero: number, totalParcelas: number): string {
  return `ATRASADO Pagamento negociação - ${numero}x${totalParcelas}`;
}

export function filtrarDebitosAbertos(
  gastos: GastoRecord[],
  motoristaKey: string,
  rastreavelKey: string,
): ResumoDebito[] {
  const out: ResumoDebito[] = [];
  for (const g of gastos) {
    const mk = refKey(g.motorista);
    const rk = refKey(g.rastreavel);
    if (mk !== motoristaKey || rk !== rastreavelKey) continue;
    const info = String(g.info ?? "").trim();
    if (info.startsWith("[NEGOCIADO")) continue;
    const total = Number(g.total ?? 0);
    if (!Number.isFinite(total) || total <= 0) continue;
    out.push({
      id: g.id!,
      info,
      total,
      data: g.data as string | undefined,
      tipo: (g.tipo as { key?: string })?.key,
    });
  }
  out.sort((a, b) => String(a.data ?? "").localeCompare(String(b.data ?? "")));
  return out;
}

export async function listarDebitosAbertos(
  motoristaKey: string,
  rastreavelKey: string,
): Promise<ResumoDebito[]> {
  const gastos = await fetchAllGastos();
  return filtrarDebitosAbertos(gastos, motoristaKey, rastreavelKey);
}

export function somarDebitos(debitos: ResumoDebito[]): number {
  return Math.round(debitos.reduce((s, d) => s + d.total, 0) * 100) / 100;
}

export function validarParcelas(
  totalNegociado: number,
  parcelas: ParcelaRenegociacao[],
): { ok: boolean; soma: number; diff: number } {
  const soma = Math.round(parcelas.reduce((s, p) => s + p.valor, 0) * 100) / 100;
  const diff = Math.round((soma - totalNegociado) * 100) / 100;
  return { ok: Math.abs(diff) < 0.02, soma, diff };
}

export function buildPutNegociado(
  gasto: GastoRecord,
  codigo: string,
): GastoRecord {
  const body = { ...gasto } as GastoRecord;
  body.info = infoMarcadaNegociada(String(gasto.info ?? ""), codigo);
  return body;
}

export function buildPostParcela(
  input: Pick<RenegociacaoInput, "motoristaKey" | "rastreavelKey">,
  parcela: ParcelaRenegociacao,
): Record<string, unknown> {
  return {
    total: parcela.valor,
    rastreavel: { key: input.rastreavelKey },
    tipo: { key: "DOCUMENTACAO" },
    motorista: { key: input.motoristaKey },
    info: infoParcelaRenegociacao(parcela.numero, parcela.totalParcelas),
    data: dataPagamentoParaIso(parcela.data),
  };
}

export type RenegociacaoResult = {
  marcados: { id: number | string; infoAntes: string; infoDepois: string }[];
  parcelasCriadas: { info: string; valor: number; data: string }[];
  avisos: string[];
};

export async function executarRenegociacao(
  input: RenegociacaoInput,
  opts?: { execute?: boolean },
): Promise<RenegociacaoResult> {
  const execute = opts?.execute === true;
  const marcados: RenegociacaoResult["marcados"] = [];
  const parcelasCriadas: RenegociacaoResult["parcelasCriadas"] = [];
  const avisos: string[] = [];

  const gastosAtual: GastoRecord[] = await fetchAllGastos();

  for (const id of input.gastosIds) {
    let gasto = await fetchGastoById(id);
    const infoAntes = String(gasto.info ?? "");
    const body = buildPutNegociado(gasto, input.negociacaoCodigo);

    const dup = gastosAtual.find(
      (g) =>
        g.id !== id &&
        String(g.info ?? "").trim() === String(body.info ?? "").trim() &&
        refKey(g.motorista) === refKey(body.motorista) &&
        refKey(g.rastreavel) === refKey(body.rastreavel),
    );
    if (dup) {
      avisos.push(`Gasto ${id}: info duplicada após marcação — revisar.`);
    }

    if (execute) {
      const r = await putGasto(id, body);
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`PUT gasto ${id} falhou: ${r.status} ${t.slice(0, 200)}`);
      }
      gasto = (await r.json()) as GastoRecord;
    }

    marcados.push({
      id,
      infoAntes,
      infoDepois: String(body.info ?? ""),
    });
  }

  for (const p of input.parcelas) {
    const body = buildPostParcela(input, p);
    const info = String(body.info);

    const dup = gastosAtual.some(
      (g) =>
        String(g.info ?? "").trim() === info &&
        refKey(g.motorista) === input.motoristaKey &&
        refKey(g.rastreavel) === input.rastreavelKey,
    );
    if (dup) {
      avisos.push(`Parcela ${info} já existe — skip POST.`);
      continue;
    }

    if (execute) {
      const r = await postGasto(body);
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`POST parcela ${info} falhou: ${r.status} ${t.slice(0, 200)}`);
      }
    }

    parcelasCriadas.push({
      info,
      valor: p.valor,
      data: String(body.data),
    });
  }

  return { marcados, parcelasCriadas, avisos };
}
