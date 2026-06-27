/**
 * API /keek/rest/rastreavel — listagem e CRUD.
 */
import { RASTREAME_ORIGIN, rastreameJsonHeaders } from "./auth.js";
import { fetchRastreameWith401Retry } from "./fetchRetry.js";
import { refKey } from "./placaRastreavel.js";

const RASTREAVEL_BASE = `${RASTREAME_ORIGIN}/keek/rest/rastreavel`;

export type Rastreavel = {
  id?: string | number;
  key?: string | number;
  value?: string;
  ativo?: boolean;
  [key: string]: unknown;
};

async function parseListResponse(r: Response): Promise<Rastreavel[]> {
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`rastreavel list HTTP ${r.status}: ${t.slice(0, 200)}`);
  }
  const d = (await r.json()) as { content?: Rastreavel[] } | Rastreavel[];
  if (Array.isArray(d)) return d;
  return d.content ?? [];
}

async function fetchRastreavelPage(
  params: Record<string, string>,
): Promise<Rastreavel[]> {
  const q = new URLSearchParams(params);
  const r = await fetchRastreameWith401Retry(`${RASTREAVEL_BASE}?${q.toString()}`, {
    headers: await rastreameJsonHeaders(false),
  });
  return parseListResponse(r);
}

/** Lista rastreáveis ativos (compatível com código existente). */
export async function listRastreaveis(): Promise<Rastreavel[]> {
  return fetchRastreavelPage({ ativo: "true", size: "2000" });
}

/** Lista todos os rastreáveis (ativos e inativos), paginado. */
export async function fetchAllRastreaveis(size = 100): Promise<Rastreavel[]> {
  const all: Rastreavel[] = [];
  const seen = new Set<string>();
  let page = 0;
  for (;;) {
    const chunk = await fetchRastreavelPage({
      page: String(page),
      size: String(size),
    });
    for (const r of chunk) {
      const k = refKey(r);
      if (k && !seen.has(k)) {
        seen.add(k);
        all.push(r);
      }
    }
    if (chunk.length < size) break;
    page++;
    if (page > 500) break;
  }
  return all;
}

export async function fetchRastreavelByKey(key: string | number): Promise<Rastreavel> {
  const r = await fetchRastreameWith401Retry(`${RASTREAVEL_BASE}/${key}`, {
    headers: await rastreameJsonHeaders(false),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`rastreavel GET ${key} HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as Rastreavel;
}

export async function postRastreavel(body: unknown): Promise<Rastreavel> {
  const r = await fetchRastreameWith401Retry(`${RASTREAVEL_BASE}/`, {
    method: "POST",
    headers: await rastreameJsonHeaders(true),
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`rastreavel POST HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as Rastreavel;
}

export async function putRastreavel(key: string | number, body: unknown): Promise<void> {
  const r = await fetchRastreameWith401Retry(`${RASTREAVEL_BASE}/${key}`, {
    method: "PUT",
    headers: await rastreameJsonHeaders(true),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`rastreavel PUT ${key} HTTP ${r.status}: ${t.slice(0, 300)}`);
  }
}

export async function inativarRastreavel(key: string | number): Promise<void> {
  const atual = await fetchRastreavelByKey(key);
  await putRastreavel(key, { ...atual, ativo: false });
}
