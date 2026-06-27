/**
 * Login assistido (Playwright) no DETRAN RS via gov.br.
 *
 * Por quê: o portal pcsdetran.rs.gov.br autentica EXCLUSIVAMENTE pelo gov.br
 * (Login Cidadão / OAuth2). Não há captcha próprio do DETRAN. Duas formas de login:
 *
 *   1) CERTIFICADO DIGITAL A1 (recomendado — gratuito, normalmente SEM reCAPTCHA):
 *      o gov.br aceita o certificado por mTLS, sem senha nem captcha. Configure
 *      DETRAN_RS_PFX_PATH/DETRAN_RS_PFX_PASS (ou os genéricos DETRAN_PFX_PATH/
 *      DETRAN_PFX_PASS). Em redes com interceção TLS use --os-cert (certificado
 *      do repositório do Windows, sem o proxy interno do Playwright).
 *   2) CPF + SENHA (fallback): DETRAN_RS_GOV_CPF/DETRAN_RS_GOV_SENHA são
 *      auto-preenchidos e VOCÊ resolve o reCAPTCHA/2FA na janela.
 *
 * Em ambos, quando o portal carrega capturamos da rede:
 *   - Authorization (Bearer)  -> DETRAN_RS_AUTH
 *   - X-User-Id               -> DETRAN_RS_USER_ID
 *
 * O token vai para um ficheiro temporário do SO (fora do Dropbox); o PowerShell
 * (scripts/login-detran-rs.ps1) lê-o, grava as variáveis de ambiente e apaga-o.
 * Nunca imprimimos o token — só metadados.
 *
 * Uso: npx tsx scripts/capturarDetranRsToken.ts [--os-cert] [--manual]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";

const PORTAL = "https://pcsdetran.rs.gov.br/";
const API_HOST = "pcsdetran.procergs.com.br";
const OUT_FILE = path.join(os.tmpdir(), "detran_rs_capture.json");
const TIMEOUT_MS = 15 * 60 * 1000;

// Certificado A1 (.pfx): RS-específico tem prioridade, senão usa o genérico do
// DETRAN (mesmo certificado/CPF serve para SC e RS). Caminho + senha SEMPRE das
// variáveis de ambiente do utilizador — nunca do repo.
const PFX_PATH =
  process.env.DETRAN_RS_PFX_PATH?.trim() || process.env.DETRAN_PFX_PATH?.trim();
const PFX_PASS =
  process.env.DETRAN_RS_PFX_PASS ?? process.env.DETRAN_PFX_PASS ?? "";

// Fallback CPF/senha (só usado se não houver certificado configurado).
const CPF = (process.env.DETRAN_RS_GOV_CPF ?? "").replace(/\D/g, "");
const SENHA = process.env.DETRAN_RS_GOV_SENHA ?? "";

// Origens onde o gov.br pede o certificado de cliente (mTLS).
const CERT_ORIGINS = [
  "https://certificado.sso.acesso.gov.br",
  "https://sso.acesso.gov.br",
];

const cap: { auth?: string; userId?: string } = {};
const tmpParaLimpar: string[] = [];
let okPrinted = false;

function persist(): void {
  fs.writeFileSync(OUT_FILE, JSON.stringify(cap, null, 2), "utf8");
  if (cap.auth && cap.userId && !okPrinted) {
    okPrinted = true;
    // Sentinela para o agente/PowerShell: NÃO imprime o token, só metadados.
    console.log(
      `CAPTURA_OK auth=${cap.auth.length}c userId=${cap.userId.length}c file=${OUT_FILE}`,
    );
  }
}

/** Localiza um openssl com provider `legacy` (o do Git/mingw64 traz). */
function acharOpenssl(): string | null {
  const cands = [
    process.env.OPENSSL_BIN,
    "C:/Program Files/Git/mingw64/bin/openssl.exe",
  ].filter((x): x is string => !!x);
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

/**
 * O Node/OpenSSL 3 recusa .pfx com algoritmos legados. Converte para um .pfx
 * moderno num ficheiro temporário (apagado ao sair). Se não der para converter,
 * devolve o original.
 */
function prepararPfxModerno(pfxPath: string, pass: string): string {
  const ssl = acharOpenssl();
  if (!ssl) return pfxPath;
  const pem = path.join(os.tmpdir(), `lanza_rs_pfx_${process.pid}.pem`);
  const modern = path.join(os.tmpdir(), `lanza_rs_pfx_${process.pid}.pfx`);
  const env = { ...process.env, LANZA_PFX_PASS: pass };
  try {
    execFileSync(
      ssl,
      ["pkcs12", "-in", pfxPath, "-legacy", "-nodes", "-passin", "env:LANZA_PFX_PASS", "-out", pem],
      { env, stdio: "pipe" },
    );
    execFileSync(
      ssl,
      [
        "pkcs12", "-in", pem, "-export", "-out", modern,
        "-passin", "env:LANZA_PFX_PASS", "-passout", "env:LANZA_PFX_PASS",
        "-keypbe", "AES-256-CBC", "-certpbe", "AES-256-CBC", "-macalg", "SHA256",
      ],
      { env, stdio: "pipe" },
    );
    tmpParaLimpar.push(modern);
    return modern;
  } catch (e) {
    console.error(`AVISO: falha ao modernizar .pfx (${e instanceof Error ? e.message : e}); usando original.`);
    return pfxPath;
  } finally {
    fs.rmSync(pem, { force: true });
  }
}

/** Abre Chrome (ou Edge) reduzindo sinais de automação que o reCAPTCHA detecta. */
async function launch(): Promise<Browser> {
  const opts = {
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  };
  for (const channel of ["chrome", "msedge"]) {
    try {
      return await chromium.launch({ channel, ...opts });
    } catch {
      /* tenta o próximo canal */
    }
  }
  return chromium.launch(opts);
}

/** Preenche o primeiro seletor visível; devolve true se conseguiu. */
async function fillFirst(page: Page, selectors: string[], value: string): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 1200 })) {
        await loc.fill(value, { timeout: 3000 });
        return true;
      }
    } catch {
      /* seletor ausente nesta etapa */
    }
  }
  return false;
}

/** Clica no primeiro seletor visível; devolve true se conseguiu. */
async function clickFirst(page: Page, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 1200 })) {
        await loc.click({ timeout: 3000 });
        return true;
      }
    } catch {
      /* seletor ausente nesta etapa */
    }
  }
  return false;
}

/**
 * Avança o fluxo gov.br pelo CERTIFICADO DIGITAL: "Entrar gov.br" → "Seu
 * certificado digital" → "Entrar". O mTLS (handshake do cert) é tratado pelo
 * browser; não há senha nem captcha. Resiliente a variações de DOM.
 */
async function avancarGovBrCertificado(page: Page, captured: () => boolean): Promise<void> {
  const padroes = [
    /entrar com gov\.br/i,
    /gov\.br/i,
    /seu certificado digital/i,
    /certificado digital/i,
    /^entrar$/i,
    /continuar/i,
  ];
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && !captured()) {
    if (/certificado\.sso\.acesso\.gov\.br/.test(page.url())) break; // handshake do cert em curso
    for (const re of padroes) {
      for (const role of ["button", "link"] as const) {
        try {
          const loc = page.getByRole(role, { name: re }).first();
          if (await loc.isVisible({ timeout: 800 })) {
            await loc.click({ timeout: 3000 });
            await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
          }
        } catch {
          /* elemento ausente nesta etapa */
        }
      }
    }
    await page.waitForTimeout(1500);
  }
}

/**
 * Fallback CPF/senha: clica "Entrar gov.br", preenche CPF, avança, preenche a
 * senha — e PARA, deixando o utilizador resolver reCAPTCHA/2FA.
 */
async function autoPreencherCpfSenha(page: Page, captured: () => boolean): Promise<void> {
  const deadline = Date.now() + 90_000;
  let cpfFeito = false;
  let senhaFeita = false;
  while (Date.now() < deadline && !captured()) {
    const url = page.url();
    if (/pcsdetran\.rs\.gov\.br/.test(url)) {
      await clickFirst(page, [
        'button:has-text("gov.br")',
        'a:has-text("gov.br")',
        'button:has-text("Entrar")',
        'a:has-text("Entrar")',
      ]);
      await page.waitForTimeout(1500);
      continue;
    }
    if (/acesso\.gov\.br|sso\.acesso/.test(url) && CPF && !cpfFeito) {
      const fez = await fillFirst(page, [
        "input#accountId",
        'input[name="accountId"]',
        'input[autocomplete="username"]',
        'input[type="text"]:visible',
      ], CPF);
      if (fez) {
        cpfFeito = true;
        await clickFirst(page, [
          "button#enter-account-id",
          'button:has-text("Continuar")',
          'button[type="submit"]',
        ]);
        await page.waitForTimeout(1800);
        continue;
      }
    }
    if (/acesso\.gov\.br|sso\.acesso/.test(url) && SENHA && !senhaFeita) {
      const fez = await fillFirst(page, [
        "input#password",
        'input[name="password"]',
        'input[type="password"]:visible',
      ], SENHA);
      if (fez) {
        senhaFeita = true;
        console.log(
          "CPF e senha preenchidos. Resolva o reCAPTCHA/2FA na janela e conclua o login — a captura segue ativa.",
        );
        return;
      }
    }
    await page.waitForTimeout(1200);
  }
}

async function main(): Promise<void> {
  const manual = process.argv.includes("--manual");
  const osCert = process.argv.includes("--os-cert");

  const browser = await launch();

  // Decisão de método (prioriza CERTIFICADO, que dispensa captcha):
  //   --manual                  → você faz tudo
  //   .pfx configurado          → certificado embarcado no Playwright (mTLS)
  //   --os-cert                 → certificado do repositório do Windows (Chrome nativo)
  //   só CPF/senha definidos     → fallback CPF/senha (você resolve o captcha)
  //   nada configurado          → PADRÃO: certificado do Windows (você seleciona no dialog)
  let clientCertificates:
    | { origin: string; pfxPath: string; passphrase: string }[]
    | undefined;
  const temPfx = !!(PFX_PATH && fs.existsSync(PFX_PATH));
  const usaCpfSenha = !temPfx && !osCert && !!CPF && !!SENHA;
  const usaCertificado = !manual && !usaCpfSenha; // default = certificado

  if (manual) {
    /* nada a configurar */
  } else if (temPfx) {
    const pfxUsavel = prepararPfxModerno(PFX_PATH!, PFX_PASS);
    clientCertificates = CERT_ORIGINS.map((origin) => ({
      origin,
      pfxPath: pfxUsavel,
      passphrase: PFX_PASS,
    }));
  } else if (PFX_PATH) {
    console.error(`AVISO: .pfx não encontrado em ${PFX_PATH} — usando o certificado do Windows.`);
  }

  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, clientCertificates });
  // Esconde navigator.webdriver (sinal clássico de automação para o reCAPTCHA).
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await ctx.newPage();

  ctx.on("request", (req) => {
    const url = req.url();
    if (!url.includes(API_HOST)) return;
    const h = req.headers();
    const auth = h["authorization"];
    const uid = h["x-user-id"];
    let changed = false;
    if (auth && /^Bearer\s/i.test(auth)) {
      cap.auth = auth.replace(/^Bearer\s+/i, "");
      changed = true;
    }
    if (uid) {
      cap.userId = uid;
      changed = true;
    }
    if (changed) persist();
  });

  await page.goto(PORTAL, { waitUntil: "domcontentloaded" }).catch(() => {});
  const captured = () => !!(cap.auth && cap.userId);

  if (manual) {
    console.log("Modo manual: faça o login gov.br na janela; eu capturo o token automaticamente.");
  } else if (usaCertificado) {
    console.log(
      clientCertificates
        ? "Navegador aberto com certificado A1 embarcado (.pfx). Automatizando login gov.br (sem captcha)..."
        : "Navegador aberto. Vou ao login por certificado; SELECIONE o seu certificado digital quando o Chrome pedir (e digite o PIN, se for token A3).",
    );
    await avancarGovBrCertificado(page, captured).catch(() => {});
    if (!captured()) {
      console.log("Se ainda não entrou: selecione o certificado / clique em 'Entrar com certificado' na janela — a captura segue ativa.");
    }
  } else {
    console.log("Auto-preenchendo CPF/senha do gov.br — resolva o reCAPTCHA/2FA na janela (a captura segue ativa)...");
    await autoPreencherCpfSenha(page, captured).catch(() => {});
  }
  console.log("Ao terminar, FECHE a janela do navegador para finalizar (timeout: 15 min).");

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, TIMEOUT_MS);
    browser.on("disconnected", () => {
      clearTimeout(timer);
      resolve();
    });
    const poll = setInterval(() => {
      if (captured()) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      }
    }, 1500);
  });

  await browser.close().catch(() => {});
  for (const f of tmpParaLimpar) fs.rmSync(f, { force: true });
  console.log(
    `FIM. token=${cap.auth ? "OK" : "não capturado"} | userId=${cap.userId ? "OK" : "não capturado"}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
