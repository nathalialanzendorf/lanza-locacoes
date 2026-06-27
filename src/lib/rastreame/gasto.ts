/**
 * API /keek/rest/gasto — Gastos Gerais (recebimentos, etc.).
 * A listagem usa parâmetros típicos Spring Data; se falhar, ajustar query
 * conforme o XHR capturado no DevTools na UI de gastos.
 */
import { RASTREAME_ORIGIN, rastreameJsonHeaders } from "./auth.js";
import { fetchRastreameWith401Retry } from "./fetchRetry.js";

const GASTO_ROOT = `${RASTREAME_ORIGIN}/keek/rest/gasto`;

export type ListGastosParams = {
  page?: number;
  size?: number;
  /** Início do período (ISO 8601, ex.: 2026-01-01T03:00:00.000Z). Obrigatório pela API. */
  dataInicial?: string;
  /** Fim do período (ISO 8601). Obrigatório pela API. */
  dataFinal?: string;
};

/** Início do ano (UTC) em ISO 8601 com milissegundos — formato aceite pela API. */
function isoInicioAno(ano: number): string {
  return new Date(Date.UTC(ano, 0, 1, 0, 0, 0, 0)).toISOString();
}

/** Fim do ano (UTC) em ISO 8601 com milissegundos. */
function isoFimAno(ano: number): string {
  return new Date(Date.UTC(ano, 11, 31, 23, 59, 59, 0)).toISOString();
}

/**
 * GET lista paginada (resposta JSON crua).
 * A API exige `dataInicial`/`dataFinal` (período); por defeito usa o ano corrente.
 */
export async function fetchGastosList(
  params: ListGastosParams = {},
): Promise<Response> {
  const page = params.page ?? 0;
  const size = params.size ?? 50;
  const anoAtual = new Date().getFullYear();
  const q = new URLSearchParams({
    dataInicial: params.dataInicial ?? isoInicioAno(anoAtual),
    dataFinal: params.dataFinal ?? isoFimAno(anoAtual),
    motorista: "null",
    page: String(page),
    size: String(size),
  });
  const url = `${GASTO_ROOT}?${q.toString()}`;
  return fetchRastreameWith401Retry(url, {
    method: "GET",
    headers: await rastreameJsonHeaders(false),
  });
}

/** POST cria gasto; corpo = objeto serializado em JSON. */
export async function postGasto(body: unknown): Promise<Response> {
  return fetchRastreameWith401Retry(`${GASTO_ROOT}/`, {
    method: "POST",
    headers: await rastreameJsonHeaders(true),
    body: JSON.stringify(body),
  });
}

/** PUT atualiza gasto existente. */
export async function putGasto(id: string | number, body: unknown): Promise<Response> {
  return fetchRastreameWith401Retry(`${GASTO_ROOT}/${id}`, {
    method: "PUT",
    headers: await rastreameJsonHeaders(true),
    body: JSON.stringify(body),
  });
}

export type GastoRecord = Record<string, unknown> & {
  id?: number | string;
  info?: string;
  total?: number;
  motorista?: { key?: string; id?: string | number; value?: string };
  rastreavel?: { key?: string; id?: string | number; value?: string };
  tipo?: { key?: string; value?: string };
};

/** GET um gasto pelo id (corpo completo para PUT). */
export async function fetchGastoById(id: string | number): Promise<GastoRecord> {
  const r = await fetchRastreameWith401Retry(`${GASTO_ROOT}/${id}`, {
    method: "GET",
    headers: await rastreameJsonHeaders(false),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`gasto GET ${id} HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as GastoRecord;
}

/** Ano mais antigo a consultar quando não há intervalo explícito. */
const GASTO_ANO_INICIAL = 2025;

/**
 * Normaliza o corpo da resposta: a API devolve um array puro,
 * mas mantemos compatibilidade com paginação Spring (`{ content: [...] }`).
 */
function parseGastosBody(body: unknown): { itens: GastoRecord[]; paginado: boolean } {
  if (Array.isArray(body)) return { itens: body as GastoRecord[], paginado: false };
  const page = body as { content?: GastoRecord[] };
  if (Array.isArray(page?.content)) return { itens: page.content, paginado: true };
  return { itens: [], paginado: false };
}

/** Lista um intervalo (janela de período); pagina só se a API devolver `content`. */
async function fetchGastosIntervalo(
  dataInicial: string,
  dataFinal: string,
  size: number,
): Promise<GastoRecord[]> {
  const out: GastoRecord[] = [];
  let page = 0;
  for (;;) {
    const r = await fetchGastosList({ page, size, dataInicial, dataFinal });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`gastos list HTTP ${r.status}: ${t.slice(0, 300)}`);
    }
    const { itens, paginado } = parseGastosBody(await r.json());
    out.push(...itens);
    if (!paginado || itens.length < size) break;
    page++;
    if (page > 500) break;
  }
  return out;
}

/**
 * Lista todos os gastos, iterando por janelas anuais
 * (a API só aceita intervalos de ~1 ano por consulta) e deduplicando por id.
 */
export async function fetchAllGastos(size = 100): Promise<GastoRecord[]> {
  const anoFinal = new Date().getFullYear() + 1;
  const porId = new Map<string, GastoRecord>();
  const semId: GastoRecord[] = [];
  for (let ano = GASTO_ANO_INICIAL; ano <= anoFinal; ano++) {
    const chunk = await fetchGastosIntervalo(
      isoInicioAno(ano),
      isoFimAno(ano),
      size,
    );
    for (const g of chunk) {
      if (g.id != null) porId.set(String(g.id), g);
      else semId.push(g);
    }
  }
  return [...porId.values(), ...semId];
}

/** Exclusão lógica no Rastreame (ativo=false). */
export async function inativarGasto(id: string | number): Promise<void> {
  const g = await fetchGastoById(id);
  const body = { ...g, ativo: false };
  const r = await putGasto(id, body);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`gasto inativar ${id} HTTP ${r.status}: ${t.slice(0, 300)}`);
  }
}
