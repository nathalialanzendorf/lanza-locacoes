/**
 * HTTP de baixo nível para o BFF de pedagiodigital.com.
 */
import {
  clearPedagioSession,
  PEDAGIO_DIGITAL_API_BASE,
  pedagioDigitalJsonHeaders,
  refreshPedagioSession,
} from "./auth.js";

/** Erro de autenticação (sessão expirada / credenciais inválidas). */
export class PedagioAuthError extends Error {
  status: number;
  constructor(status: number, detail = "") {
    super(
      `pedagiodigital sessão inválida (HTTP ${status}). Recapture PEDAGIO_DIGITAL_COOKIE + PEDAGIO_DIGITAL_CSRF (logado no DevTools).${detail ? ` ${detail}` : ""}`,
    );
    this.name = "PedagioAuthError";
    this.status = status;
  }
}

export type BffFetchOpts = {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  referer?: string;
};

function buildUrl(path: string, query?: BffFetchOpts["query"]): string {
  const base = path.startsWith("http")
    ? path
    : `${PEDAGIO_DIGITAL_API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
  if (!query) return base;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${base}?${s}` : base;
}

async function doFetch(
  path: string,
  opts: BffFetchOpts,
): Promise<Response> {
  const url = buildUrl(path, opts.query);
  const headers = await pedagioDigitalJsonHeaders(opts.referer);
  const hasBody = opts.body !== undefined;
  if (!hasBody) delete headers["Content-Type"];
  return fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: hasBody ? JSON.stringify(opts.body) : undefined,
  });
}

/**
 * Chamada genérica ao BFF; devolve a resposta `fetch` crua.
 *
 * Em 401/403 (sessão expirada), tenta **uma vez** renovar a sessão
 * (`refreshPedagioSession` — refresh silencioso pelo navegador) e repetir.
 */
export async function bffFetchRaw(
  path: string,
  opts: BffFetchOpts = {},
): Promise<Response> {
  let r = await doFetch(path, opts);
  if (r.status === 401 || r.status === 403) {
    clearPedagioSession();
    const fresh = await refreshPedagioSession();
    if (fresh) r = await doFetch(path, opts);
  }
  return r;
}

/** Chamada ao BFF que faz parse de JSON e valida o status. */
export async function bffFetchJson<T = unknown>(
  path: string,
  opts: BffFetchOpts = {},
): Promise<T> {
  const r = await bffFetchRaw(path, opts);
  const text = await r.text();
  if (r.status === 401 || r.status === 403) {
    throw new PedagioAuthError(r.status);
  }
  if (!r.ok) {
    throw new Error(
      `pedagiodigital ${opts.method ?? "GET"} ${path} HTTP ${r.status}: ${text.slice(0, 300)}`,
    );
  }
  if (!text.trim()) return undefined as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `pedagiodigital ${path}: resposta não-JSON: ${text.slice(0, 200)}`,
    );
  }
}

/** Procura, recursivamente, o primeiro array dentro de um payload (ou chaves conhecidas). */
export function pickArray(raw: unknown, keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  const o = raw as Record<string, unknown>;
  for (const k of keys) {
    if (Array.isArray(o[k])) return o[k] as unknown[];
  }
  for (const k of ["data", "result", "resultado", "items", "content", "payload"]) {
    const nested = o[k];
    if (Array.isArray(nested)) return nested as unknown[];
    if (nested && typeof nested === "object") {
      const found = pickArray(nested, keys);
      if (found.length) return found;
    }
  }
  return [];
}
