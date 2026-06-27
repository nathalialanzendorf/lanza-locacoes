/**
 * Login GRATUITO no pedagiodigital.com via navegador real (Chrome) com Playwright.
 *
 * O login exige reCAPTCHA v2, que roda no browser. Em vez de pagar um solver,
 * abrimos o **Chrome real** num **perfil persistente** (`.cache/pedagio-digital/
 * chrome-profile`) e capturamos a sessão (cookies `bff_sid`/`bff-csrf`) para um
 * ficheiro de cache que o resto da tool consome.
 *
 * Dois modos:
 * - **interativo** (`interactiveBrowserLogin`) — janela visível; preenche CPF+senha
 *   (best-effort) e espera você resolver o reCAPTCHA + entrar. Use 1x via
 *   `pedagio-digital login`.
 * - **silencioso** (`silentBrowserRefresh`) — headless, reutiliza o perfil já
 *   logado; se o SPA reabilita a sessão sozinho (sem captcha), renova sem you tocar.
 *   Usado automaticamente pelos syncs quando a sessão expira.
 *
 * Requisitos: `playwright-core` (já em devDependencies) + Chrome instalado.
 */
import fs from "node:fs";
import path from "node:path";

import { REPO_ROOT } from "../repoRoot.js";
import type { PedagioSession } from "./auth.js";

const CACHE_DIR = path.join(REPO_ROOT, ".cache", "pedagio-digital");
const PROFILE_DIR = path.join(CACHE_DIR, "chrome-profile");
const SESSION_FILE = path.join(CACHE_DIR, "session.json");

const SITE_URL = "https://pedagiodigital.com/";

const DEFAULT_CHROME =
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

type StoredSession = PedagioSession & { savedAt: string };

/** Caminho do Chrome (env override > canal "chrome" > caminho padrão). */
function chromeExecutable(): string | undefined {
  const env = process.env.PEDAGIO_DIGITAL_CHROME_PATH?.trim();
  if (env && fs.existsSync(env)) return env;
  if (fs.existsSync(DEFAULT_CHROME)) return DEFAULT_CHROME;
  return undefined; // deixa o Playwright resolver pelo channel
}

/** Lê a sessão capturada do ficheiro de cache (se existir). */
export function readCachedSession(): PedagioSession | null {
  try {
    const raw = fs.readFileSync(SESSION_FILE, "utf8");
    const s = JSON.parse(raw) as StoredSession;
    if (s?.cookie && s?.csrf) return { cookie: s.cookie, csrf: s.csrf };
  } catch {
    /* sem cache */
  }
  return null;
}

/** Grava a sessão capturada no ficheiro de cache. */
function writeCachedSession(session: PedagioSession): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const payload: StoredSession = { ...session, savedAt: new Date().toISOString() };
  fs.writeFileSync(SESSION_FILE, JSON.stringify(payload, null, 2), "utf8");
}

/** Apaga a sessão em cache (após 401 confirmado). */
export function clearCachedSession(): void {
  try {
    fs.rmSync(SESSION_FILE, { force: true });
  } catch {
    /* ignore */
  }
}

type AnyContext = any;

/**
 * Constrói {cookie, csrf} a partir de **todos** os cookies de pedagiodigital.com
 * (inclui `www.` e domínio com ponto inicial). O site loga em `www.` mas os
 * valores de sessão são host-agnósticos — a tool os usa no host sem `www`.
 */
async function harvestSession(context: AnyContext): Promise<PedagioSession | null> {
  const all: Array<{ name: string; value: string; domain: string }> =
    await context.cookies();
  const cookies = all.filter((c) =>
    /(^|\.)pedagiodigital\.com$/i.test(c.domain.replace(/^\./, "")),
  );
  if (!cookies.length) return null;
  // dedup por nome (mantém o último), preservando a sessão real.
  const byName = new Map<string, string>();
  for (const c of cookies) byName.set(c.name, c.value);
  const cookieHeader = [...byName].map(([k, v]) => `${k}=${v}`).join("; ");
  const csrf = byName.get("bff-csrf") ?? byName.get("XSRF-TOKEN") ?? "";
  const hasSid = byName.has("bff_sid");
  if (!hasSid || !csrf) return null;
  return { cookie: cookieHeader, csrf };
}

/**
 * Testa o login **de dentro da página** (fetch relativo a `/bff/api/Placa/list`
 * com `credentials: include`), que carrega os cookies do origin atual e não é
 * barrado pelo Akamai como uma chamada externa seria.
 */
async function isAuthenticated(page: AnyContext, csrf: string): Promise<boolean> {
  try {
    const url = String(page.url() ?? "");
    if (!/pedagiodigital\.com/i.test(url)) return false;
    const status: number = await page.evaluate(async (token: string) => {
      try {
        const r = await fetch("/bff/api/Placa/list", {
          headers: { Accept: "application/json", "x-csrf-token": token },
          credentials: "include",
        });
        return r.status;
      } catch {
        return 0;
      }
    }, csrf);
    return status === 200;
  } catch {
    return false;
  }
}

/** Captura a sessão se a página estiver autenticada; senão `null`. */
async function captureIfAuthenticated(
  context: AnyContext,
  page: AnyContext,
): Promise<PedagioSession | null> {
  const session = await harvestSession(context);
  if (!session) return null;
  if (!(await isAuthenticated(page, session.csrf))) return null;
  return session;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Preenche CPF + senha (best-effort) se os campos existirem e estiverem vazios. */
async function tryAutofill(page: AnyContext): Promise<void> {
  const cpf = process.env.PEDAGIO_DIGITAL_LOGIN?.replace(/\D/g, "");
  const senha = process.env.PEDAGIO_DIGITAL_SENHA;
  if (!cpf || !senha) return;
  const cpfSelectors = [
    'input[formcontrolname*="cpf" i]',
    'input[name*="cpf" i]',
    'input[id*="cpf" i]',
    'input[placeholder*="CPF" i]',
    'input[type="text"]',
  ];
  const senhaSelectors = [
    'input[type="password"]',
    'input[formcontrolname*="senha" i]',
    'input[name*="senha" i]',
  ];
  for (const sel of cpfSelectors) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) && !(await el.inputValue().catch(() => ""))) {
        await el.fill(cpf, { timeout: 3000 });
        break;
      }
    } catch {
      /* tenta próximo */
    }
  }
  for (const sel of senhaSelectors) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) && !(await el.inputValue().catch(() => ""))) {
        await el.fill(senha, { timeout: 3000 });
        break;
      }
    } catch {
      /* tenta próximo */
    }
  }
}

async function launchContext(headless: boolean): Promise<AnyContext> {
  const { chromium } = (await import("playwright-core")) as any;
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const exe = chromeExecutable();
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    channel: exe ? undefined : "chrome",
    executablePath: exe,
    viewport: { width: 1280, height: 860 },
    userAgent: USER_AGENT,
    ignoreHTTPSErrors: true, // interceção TLS (antivírus/proxy) desta máquina
    args: ["--disable-blink-features=AutomationControlled"],
  });
}

/**
 * Login interativo (janela visível): preenche CPF+senha e espera você resolver o
 * reCAPTCHA e entrar. Captura e cacheia a sessão. Use via `pedagio-digital login`.
 */
export async function interactiveBrowserLogin(timeoutMs = 240_000): Promise<PedagioSession | null> {
  const context = await launchContext(false);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(SITE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const already = await captureIfAuthenticated(context, page);
    if (already) {
      writeCachedSession(already);
      console.error("pedagiodigital: já estava logado no perfil — sessão capturada.");
      return already;
    }

    await sleep(1500);
    await tryAutofill(page);
    console.error(
      "pedagiodigital: resolva o reCAPTCHA e clique em ENTRAR na janela aberta. Aguardando login…",
    );

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(2500);
      const s = await captureIfAuthenticated(context, page);
      if (s) {
        writeCachedSession(s);
        console.error("pedagiodigital: login detectado — sessão capturada e cacheada.");
        return s;
      }
    }
    console.error("pedagiodigital: tempo esgotado aguardando o login na janela.");
    return null;
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Refresh silencioso (headless) reutilizando o perfil já logado. Se o SPA
 * reabilita a sessão sozinho (sem captcha), renova sem intervenção. Devolve
 * `null` se exigir login manual de novo (aí rode `pedagio-digital login`).
 */
export async function silentBrowserRefresh(timeoutMs = 45_000): Promise<PedagioSession | null> {
  if (!fs.existsSync(PROFILE_DIR)) return null; // sem perfil ainda → precisa login interativo
  let context: AnyContext;
  try {
    context = await launchContext(true);
  } catch {
    return null;
  }
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(SITE_URL, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const s = await captureIfAuthenticated(context, page);
      if (s) {
        writeCachedSession(s);
        return s;
      }
      await sleep(2500);
      await page.reload({ waitUntil: "networkidle", timeout: 20_000 }).catch(() => {});
    }
    return null;
  } finally {
    await context.close().catch(() => {});
  }
}
