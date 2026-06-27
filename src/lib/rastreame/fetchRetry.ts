import { rastreameJsonHeaders, refreshRastreameToken } from "./auth.js";

/** Repete o pedido após refresh do token em HTTP 401. */
export async function fetchRastreameWith401Retry(
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers =
    init.headers ?? (await rastreameJsonHeaders(method !== "GET"));
  let r = await fetch(url, { ...init, headers });
  if (r.status === 401) {
    await refreshRastreameToken();
    const h2 = await rastreameJsonHeaders(method !== "GET");
    r = await fetch(url, { ...init, headers: h2 });
  }
  return r;
}
