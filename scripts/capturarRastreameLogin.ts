/**
 * Abre um Chrome controlado (Playwright), faz login em rastreame.com.br com
 * RASTREAME_LOGIN / RASTREAME_SENHA e captura, da rede, o pedido real de login:
 *   - o header `authorization` enviado (para descobrir o FORMATO exato);
 *   - o `accessToken` devolvido (-> RASTREAME_AUTH).
 *
 * Não imprime credenciais: o formato é mostrado como molde ({LOGIN}/{SENHA}) e o
 * token vai para um ficheiro temporário do SO (fora do Dropbox).
 *
 * Uso: npx tsx scripts/capturarRastreameLogin.ts [--manual]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";

const ORIGIN = "https://rastreame.com.br";
const LOGIN_PATH = "/auth/rest/login";
const OUT_FILE = path.join(os.tmpdir(), "rastreame_capture.json");

const LOGIN = process.env.RASTREAME_LOGIN?.trim() ?? "";
const SENHA = process.env.RASTREAME_SENHA ?? "";

const cap: { token?: string; authFormat?: string; rawAuthLen?: number } = {};

/** Substitui login/senha reais por placeholders para revelar só o formato. */
function molde(decoded: string): string {
  let s = decoded;
  if (SENHA) s = s.split(SENHA).join("{SENHA}");
  if (LOGIN) s = s.split(LOGIN).join("{LOGIN}");
  return s;
}

function persist(): void {
  fs.writeFileSync(OUT_FILE, JSON.stringify(cap, null, 2), "utf8");
}

async function launch(): Promise<Browser> {
  for (const channel of ["chrome", "msedge"]) {
    try {
      return await chromium.launch({ channel, headless: false });
    } catch {
      /* tenta o próximo canal */
    }
  }
  return chromium.launch({ headless: false });
}

/** Tenta preencher e submeter o formulário de login (resiliente a seletores). */
async function autoLogin(page: Page): Promise<void> {
  if (!LOGIN || !SENHA) {
    console.log(
      "RASTREAME_LOGIN/RASTREAME_SENHA não definidos — faça login manual; a captura segue ativa.",
    );
    return;
  }
  const userSelectors = [
    'input[type="email"]',
    'input[name*="login" i]',
    'input[name*="email" i]',
    'input[name*="user" i]',
    'input[formcontrolname*="login" i]',
    'input[type="text"]',
  ];
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !cap.token) {
    const pass = page.locator('input[type="password"]').first();
    if (await pass.isVisible({ timeout: 1000 }).catch(() => false)) {
      for (const sel of userSelectors) {
        const u = page.locator(sel).first();
        if (await u.isVisible({ timeout: 500 }).catch(() => false)) {
          await u.fill(LOGIN).catch(() => {});
          break;
        }
      }
      await pass.fill(SENHA).catch(() => {});
      const botao = page
        .getByRole("button", { name: /entrar|login|acessar|conectar/i })
        .first();
      if (await botao.isVisible({ timeout: 800 }).catch(() => false)) {
        await botao.click({ timeout: 3000 }).catch(() => {});
      } else {
        await pass.press("Enter").catch(() => {});
      }
      return;
    }
    await page.waitForTimeout(1000);
  }
}

async function main(): Promise<void> {
  const browser = await launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  ctx.on("request", (req) => {
    if (!req.url().includes(LOGIN_PATH)) return;
    const auth = req.headers()["authorization"];
    if (auth) {
      cap.rawAuthLen = auth.length;
      const semScheme = auth.replace(/^[A-Za-z]+\s+/, "");
      try {
        const decoded = Buffer.from(semScheme, "base64").toString("utf8");
        cap.authFormat = molde(decoded);
      } catch {
        cap.authFormat = molde(auth);
      }
      persist();
    }
  });

  ctx.on("response", async (res) => {
    if (!res.url().includes(LOGIN_PATH)) return;
    try {
      const data = JSON.parse(await res.text()) as { accessToken?: string };
      if (data?.accessToken) {
        cap.token = data.accessToken;
        persist();
        console.log(
          `CAPTURA_OK token=${cap.token.length}c authFormat=${cap.authFormat ?? "?"} file=${OUT_FILE}`,
        );
      }
    } catch {
      /* resposta não-JSON */
    }
  });

  await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" }).catch(() => {});
  console.log("Navegador aberto. Tentando login automático...");

  if (!process.argv.includes("--manual")) {
    await autoLogin(page).catch(() => {});
  }
  if (!cap.token) {
    console.log("Aguardando login (auto/manual). FECHE a janela ao terminar (timeout 5 min).");
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5 * 60 * 1000);
    const done = setInterval(() => {
      if (cap.token) {
        clearTimeout(timer);
        clearInterval(done);
        resolve();
      }
    }, 1000);
    browser.on("disconnected", () => {
      clearTimeout(timer);
      clearInterval(done);
      resolve();
    });
  });

  await browser.close().catch(() => {});
  console.log(`FIM. token=${cap.token ? "OK" : "não capturado"} authFormat=${cap.authFormat ?? "?"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
