/**
 * Autenticação e headers HTTP para o BFF de pedagiodigital.com.
 *
 * Credenciais: CPF + senha nas variáveis de ambiente do utilizador
 * (`PEDAGIO_DIGITAL_LOGIN`, `PEDAGIO_DIGITAL_SENHA`). A tool faz login e
 * mantém a sessão (cookie `bff_sid` + CSRF `bff-csrf`/`x-csrf-token`) em cache.
 *
 * Alternativa/override (debug): capturar a sessão no DevTools em
 * `PEDAGIO_DIGITAL_COOKIE` + `PEDAGIO_DIGITAL_CSRF` — têm prioridade sobre o login.
 */
import { loadLocalEnv } from "../loadLocalEnv.js";
import {
  clearCachedSession,
  readCachedSession,
  silentBrowserRefresh,
} from "./browserLogin.js";
import { solveRecaptchaToken } from "./captcha.js";

loadLocalEnv();

if (process.env.PEDAGIO_DIGITAL_TLS_INSECURE === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

export const PEDAGIO_DIGITAL_ORIGIN = "https://pedagiodigital.com";
export const PEDAGIO_DIGITAL_BFF_BASE = "https://pedagiodigital.com/bff";
export const PEDAGIO_DIGITAL_API_BASE = `${PEDAGIO_DIGITAL_BFF_BASE}/api`;
export const PEDAGIO_DIGITAL_LOGIN_URL = `${PEDAGIO_DIGITAL_BFF_BASE}/login`;

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0";

const DEFAULT_CONCESSAO = "44";

export type PedagioSession = { cookie: string; csrf: string };

let sessionCache: PedagioSession | null = null;

export function pedagioDigitalUserAgent(): string {
  return process.env.PEDAGIO_DIGITAL_USER_AGENT?.trim() || DEFAULT_USER_AGENT;
}

/** Limpa a sessão em cache (útil após HTTP 401/403). */
export function clearPedagioSession(): void {
  sessionCache = null;
}

function sessionFromEnv(): PedagioSession | null {
  const cookie = process.env.PEDAGIO_DIGITAL_COOKIE?.trim();
  const csrf = process.env.PEDAGIO_DIGITAL_CSRF?.trim();
  if (cookie && csrf) return { cookie, csrf };
  return null;
}

/** Lê valor de um cookie a partir de uma lista de Set-Cookie. */
function cookieValue(setCookies: string[], name: string): string | null {
  for (const c of setCookies) {
    const m = c.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    if (m) return m[1]!;
  }
  return null;
}

/** Junta Set-Cookie num header `Cookie` (name=value; …). */
function joinCookies(setCookies: string[]): string {
  const pairs: string[] = [];
  for (const c of setCookies) {
    const first = c.split(";")[0]?.trim();
    if (first && first.includes("=")) pairs.push(first);
  }
  return pairs.join("; ");
}

/**
 * Faz login no BFF (`POST /bff/login`) com CPF + senha e devolve a sessão
 * (cookie `bff_sid` + CSRF `bff-csrf`).
 *
 * O login exige um token de **reCAPTCHA v2** (`tokenCaptcha`). Para automação
 * desatendida, configure um serviço solver (`PEDAGIO_DIGITAL_CAPTCHA_PROVIDER`
 * + `PEDAGIO_DIGITAL_CAPTCHA_APIKEY`) — ver `captcha.ts`. Em falta disso, passe
 * um token fresco em `PEDAGIO_DIGITAL_CAPTCHA` (válido ~2 min) ou use o override
 * de sessão `PEDAGIO_DIGITAL_COOKIE` + `PEDAGIO_DIGITAL_CSRF`.
 */
export async function loginPedagioDigital(): Promise<PedagioSession | null> {
  const login = process.env.PEDAGIO_DIGITAL_LOGIN?.trim();
  const senha = process.env.PEDAGIO_DIGITAL_SENHA?.trim();
  if (!login || !senha) return null;

  // 1) token colado manualmente (PEDAGIO_DIGITAL_CAPTCHA); 2) solver automático.
  let tokenCaptcha = process.env.PEDAGIO_DIGITAL_CAPTCHA?.trim() || "";
  if (!tokenCaptcha) {
    try {
      tokenCaptcha = (await solveRecaptchaToken()) ?? "";
    } catch (e) {
      console.error(`ERRO ao resolver reCAPTCHA via solver: ${(e as Error).message}`);
    }
  }
  if (!tokenCaptcha) {
    console.error(
      "ERRO login pedagiodigital: sem token reCAPTCHA. Configure um solver (PEDAGIO_DIGITAL_CAPTCHA_PROVIDER + PEDAGIO_DIGITAL_CAPTCHA_APIKEY) ou passe PEDAGIO_DIGITAL_CAPTCHA fresco.",
    );
    console.error(
      "Alternativa (debug): capturar a sessão no DevTools em PEDAGIO_DIGITAL_COOKIE + PEDAGIO_DIGITAL_CSRF (ver reference.md).",
    );
    return null;
  }

  const r = await fetch(PEDAGIO_DIGITAL_LOGIN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Accept-Language": "pt,en-US;q=0.9,en;q=0.8,pt-BR;q=0.7",
      "Content-Type": "application/json",
      Origin: PEDAGIO_DIGITAL_ORIGIN,
      Referer: `${PEDAGIO_DIGITAL_ORIGIN}/`,
      "User-Agent": pedagioDigitalUserAgent(),
    },
    body: JSON.stringify({
      cpfCnpj: login.replace(/\D/g, ""),
      senha,
      tokenCaptcha,
      tokenConcessao: process.env.PEDAGIO_DIGITAL_CONCESSAO?.trim() || DEFAULT_CONCESSAO,
      idUsuario: null,
    }),
  });

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    console.error(`ERRO login pedagiodigital [HTTP ${r.status}]: ${body.slice(0, 200)}`);
    return null;
  }

  const setCookies = r.headers.getSetCookie?.() ?? [];
  const csrf = cookieValue(setCookies, "bff-csrf") ?? cookieValue(setCookies, "XSRF-TOKEN") ?? "";
  const cookie = joinCookies(setCookies);

  if (!cookie || !csrf) {
    console.error(
      "ERRO login pedagiodigital: resposta sem cookies de sessão (bff_sid/bff-csrf).",
    );
    return null;
  }
  return { cookie, csrf };
}

/**
 * Sessão para pedidos autenticados. Ordem:
 * 1. cache em memória;
 * 2. override por env (`PEDAGIO_DIGITAL_COOKIE` + `PEDAGIO_DIGITAL_CSRF`);
 * 3. sessão cacheada em disco (capturada por `pedagio-digital login`);
 * 4. refresh silencioso via navegador (perfil persistente, sem captcha);
 * 5. login por credenciais + solver de captcha (se configurado).
 *
 * Uma sessão de disco eventualmente expira; nesse caso o `client.ts` apanha o
 * 401 e chama `refreshPedagioSession()` (refresh silencioso) antes de repetir.
 */
export async function getPedagioSession(): Promise<PedagioSession> {
  if (sessionCache) return sessionCache;

  const fromEnv = sessionFromEnv();
  if (fromEnv) {
    sessionCache = fromEnv;
    return fromEnv;
  }

  const fromFile = readCachedSession();
  if (fromFile) {
    sessionCache = fromFile;
    return fromFile;
  }

  const fromBrowser = await silentBrowserRefresh().catch(() => null);
  if (fromBrowser) {
    sessionCache = fromBrowser;
    return fromBrowser;
  }

  const fromLogin = await loginPedagioDigital();
  if (fromLogin) {
    sessionCache = fromLogin;
    return fromLogin;
  }

  console.error(
    "ERRO: sem sessão pedagiodigital. Rode `npx tsx src/run.ts pedagio-digital login` para entrar com CPF+senha (resolve o reCAPTCHA na janela) — a sessão fica em cache e renova sozinha.",
  );
  console.error(
    "Alternativas: PEDAGIO_DIGITAL_COOKIE + PEDAGIO_DIGITAL_CSRF (DevTools) ou um solver (PEDAGIO_DIGITAL_CAPTCHA_PROVIDER + _APIKEY).",
  );
  process.exit(2);
}

/**
 * Força a renovação da sessão após um 401: limpa caches (memória + disco) e
 * tenta um refresh silencioso pelo navegador. Devolve a nova sessão ou `null`
 * (aí é preciso `pedagio-digital login` interativo).
 */
export async function refreshPedagioSession(): Promise<PedagioSession | null> {
  sessionCache = null;
  clearCachedSession();
  const fresh = await silentBrowserRefresh().catch(() => null);
  if (fresh) {
    sessionCache = fresh;
    return fresh;
  }
  const viaLogin = await loginPedagioDigital().catch(() => null);
  if (viaLogin) {
    sessionCache = viaLogin;
    return viaLogin;
  }
  return null;
}

/** Headers padrão para chamadas ao BFF (JSON). */
export async function pedagioDigitalJsonHeaders(
  referer = `${PEDAGIO_DIGITAL_ORIGIN}/`,
): Promise<Record<string, string>> {
  const s = await getPedagioSession();
  return {
    Accept: "application/json",
    "Accept-Language": "pt,en-US;q=0.9,en;q=0.8,pt-BR;q=0.7",
    "Content-Type": "application/json",
    Cookie: s.cookie,
    Origin: PEDAGIO_DIGITAL_ORIGIN,
    Referer: referer,
    "User-Agent": pedagioDigitalUserAgent(),
    "X-Csrf-Token": s.csrf,
  };
}
