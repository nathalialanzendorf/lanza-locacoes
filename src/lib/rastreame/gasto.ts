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
};

/** GET lista paginada (resposta JSON crua). */
export async function fetchGastosList(
  params: ListGastosParams = {},
): Promise<Response> {
  const page = params.page ?? 0;
  const size = params.size ?? 50;
  const q = new URLSearchParams({
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

/** Lista paginada até esgotar (máx. 500 páginas). */
export async function fetchAllGastos(size = 100): Promise<GastoRecord[]> {
  const all: GastoRecord[] = [];
  let page = 0;
  for (;;) {
    const r = await fetchGastosList({ page, size });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`gastos list HTTP ${r.status}: ${t.slice(0, 300)}`);
    }
    const d = (await r.json()) as { content?: GastoRecord[] };
    const chunk = d.content ?? [];
    all.push(...chunk);
    if (chunk.length < size) break;
    page++;
    if (page > 500) break;
  }
  return all;
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
