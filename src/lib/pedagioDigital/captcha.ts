/**
 * Resolução automática do reCAPTCHA v2 do login de pedagiodigital.com.
 *
 * O login (`POST /bff/login`) exige um `tokenCaptcha` (= `g-recaptcha-response`
 * do reCAPTCHA **v2** do site). Para automação desatendida (scheduler), este
 * módulo delega a resolução a um **serviço solver** de terceiros, configurado
 * por variáveis de ambiente do utilizador:
 *
 * | Variável | Uso |
 * |----------|-----|
 * | `PEDAGIO_DIGITAL_CAPTCHA_PROVIDER` | `capsolver` (default) \| `2captcha` \| `anticaptcha` |
 * | `PEDAGIO_DIGITAL_CAPTCHA_APIKEY` | API key da conta no serviço solver |
 * | `PEDAGIO_DIGITAL_CAPTCHA_SITEKEY` | Opcional — sobrescreve a site key (default: a do site) |
 * | `PEDAGIO_DIGITAL_CAPTCHA_TIMEOUT_MS` | Opcional — tempo máx. de espera (default 120000) |
 *
 * Se nenhum provider/API key estiver configurado, `solveRecaptchaToken()` devolve
 * `null` e o fluxo de login cai de volta para `PEDAGIO_DIGITAL_CAPTCHA` (token
 * colado manualmente) ou para o override de sessão `COOKIE`+`CSRF`.
 */
// Mesma interceção TLS do resto da tool (antivírus/proxy MITM nesta máquina).
if (process.env.PEDAGIO_DIGITAL_TLS_INSECURE === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

/** URL do site para os serviços solver (igual a PEDAGIO_DIGITAL_ORIGIN). */
const PEDAGIO_DIGITAL_WEBSITE_URL = "https://pedagiodigital.com/";

/** Site key pública do reCAPTCHA v2 de pedagiodigital.com (login + cadastro de placa). */
export const PEDAGIO_DIGITAL_RECAPTCHA_SITEKEY =
  "6LfNthIrAAAAAIezkzLOg01fWHcyQtk-PjbraHwz";

const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 5_000;

export type CaptchaProvider = "capsolver" | "2captcha" | "anticaptcha";

function provider(): CaptchaProvider {
  const p = process.env.PEDAGIO_DIGITAL_CAPTCHA_PROVIDER?.trim().toLowerCase();
  if (p === "2captcha" || p === "anticaptcha" || p === "capsolver") return p;
  return "capsolver";
}

function apiKey(): string | null {
  return process.env.PEDAGIO_DIGITAL_CAPTCHA_APIKEY?.trim() || null;
}

function siteKey(): string {
  return (
    process.env.PEDAGIO_DIGITAL_CAPTCHA_SITEKEY?.trim() ||
    PEDAGIO_DIGITAL_RECAPTCHA_SITEKEY
  );
}

function timeoutMs(): number {
  const v = Number(process.env.PEDAGIO_DIGITAL_CAPTCHA_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postJson<T = any>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`solver resposta não-JSON (${url}): ${text.slice(0, 200)}`);
  }
}

/**
 * Resolve via **CapSolver** (api.capsolver.com) — ReCaptchaV2TaskProxyLess.
 * Doc: createTask → getTaskResult (poll).
 */
async function solveCapSolver(key: string, deadline: number): Promise<string> {
  const create = await postJson<{
    errorId: number;
    errorDescription?: string;
    taskId?: string;
  }>("https://api.capsolver.com/createTask", {
    clientKey: key,
    task: {
      type: "ReCaptchaV2TaskProxyLess",
      websiteURL: PEDAGIO_DIGITAL_WEBSITE_URL,
      websiteKey: siteKey(),
    },
  });
  if (create.errorId || !create.taskId) {
    throw new Error(`CapSolver createTask falhou: ${create.errorDescription ?? "sem taskId"}`);
  }
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const res = await postJson<{
      errorId: number;
      errorDescription?: string;
      status?: string;
      solution?: { gRecaptchaResponse?: string };
    }>("https://api.capsolver.com/getTaskResult", {
      clientKey: key,
      taskId: create.taskId,
    });
    if (res.errorId) {
      throw new Error(`CapSolver getTaskResult erro: ${res.errorDescription ?? "desconhecido"}`);
    }
    if (res.status === "ready" && res.solution?.gRecaptchaResponse) {
      return res.solution.gRecaptchaResponse;
    }
  }
  throw new Error("CapSolver: tempo esgotado aguardando solução do reCAPTCHA.");
}

/**
 * Resolve via **Anti-Captcha** (api.anti-captcha.com) — RecaptchaV2TaskProxyless.
 */
async function solveAntiCaptcha(key: string, deadline: number): Promise<string> {
  const create = await postJson<{
    errorId: number;
    errorDescription?: string;
    taskId?: number;
  }>("https://api.anti-captcha.com/createTask", {
    clientKey: key,
    task: {
      type: "RecaptchaV2TaskProxyless",
      websiteURL: PEDAGIO_DIGITAL_WEBSITE_URL,
      websiteKey: siteKey(),
    },
  });
  if (create.errorId || !create.taskId) {
    throw new Error(`Anti-Captcha createTask falhou: ${create.errorDescription ?? "sem taskId"}`);
  }
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const res = await postJson<{
      errorId: number;
      errorDescription?: string;
      status?: string;
      solution?: { gRecaptchaResponse?: string };
    }>("https://api.anti-captcha.com/getTaskResult", {
      clientKey: key,
      taskId: create.taskId,
    });
    if (res.errorId) {
      throw new Error(`Anti-Captcha getTaskResult erro: ${res.errorDescription ?? "desconhecido"}`);
    }
    if (res.status === "ready" && res.solution?.gRecaptchaResponse) {
      return res.solution.gRecaptchaResponse;
    }
  }
  throw new Error("Anti-Captcha: tempo esgotado aguardando solução do reCAPTCHA.");
}

/**
 * Resolve via **2Captcha** (api.2captcha.com, API nova compatível com Anti-Captcha).
 */
async function solve2Captcha(key: string, deadline: number): Promise<string> {
  const create = await postJson<{
    errorId: number;
    errorDescription?: string;
    taskId?: number;
  }>("https://api.2captcha.com/createTask", {
    clientKey: key,
    task: {
      type: "RecaptchaV2TaskProxyless",
      websiteURL: PEDAGIO_DIGITAL_WEBSITE_URL,
      websiteKey: siteKey(),
    },
  });
  if (create.errorId || !create.taskId) {
    throw new Error(`2Captcha createTask falhou: ${create.errorDescription ?? "sem taskId"}`);
  }
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const res = await postJson<{
      errorId: number;
      errorDescription?: string;
      status?: string;
      solution?: { gRecaptchaResponse?: string; token?: string };
    }>("https://api.2captcha.com/getTaskResult", {
      clientKey: key,
      taskId: create.taskId,
    });
    if (res.errorId) {
      throw new Error(`2Captcha getTaskResult erro: ${res.errorDescription ?? "desconhecido"}`);
    }
    const token = res.solution?.gRecaptchaResponse ?? res.solution?.token;
    if (res.status === "ready" && token) return token;
  }
  throw new Error("2Captcha: tempo esgotado aguardando solução do reCAPTCHA.");
}

/**
 * Obtém um `tokenCaptcha` (g-recaptcha-response) via serviço solver configurado.
 * Devolve `null` se não houver provider/API key — para o login cair no fallback.
 */
export async function solveRecaptchaToken(): Promise<string | null> {
  const key = apiKey();
  if (!key) return null;

  const which = provider();
  const deadline = Date.now() + timeoutMs();
  console.error(`pedagiodigital: resolvendo reCAPTCHA v2 via ${which}…`);

  if (which === "capsolver") return solveCapSolver(key, deadline);
  if (which === "anticaptcha") return solveAntiCaptcha(key, deadline);
  return solve2Captcha(key, deadline);
}
