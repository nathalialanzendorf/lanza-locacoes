/**
 * Abre um Chrome controlado (Playwright) para o operador logar no DETRAN SC com
 * certificado digital A1 (via gov.br). Captura, da rede:
 *   - Authorization (Bearer JWT)  -> DETRAN_SC_AUTH
 *   - X-Empresa                   -> DETRAN_SC_EMPRESA
 *   - X-App-Version               -> DETRAN_SC_APP_VERSION
 * e salva o JSON de cada `resposta-consulta` por placa (para sync offline).
 *
 * Uso: npx tsx scripts/capturarDetranToken.ts
 * O JWT é escrito num ficheiro temporário do SO (fora do Dropbox); o PowerShell
 * depois lê-o para definir as variáveis de ambiente e apaga-o.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium, type Browser } from "playwright-core";

const API_HOST = "backend.detran.sc.gov.br";
const PORTAL = "https://servicos.detran.sc.gov.br/";
const AUTH_FILE = path.join(os.tmpdir(), "detran_capture.json");
const RESP_DIR = path.resolve("relatorios/_tmp/detran_respostas");

// Certificado A1 (.pfx) para apresentação automática no desafio TLS do gov.br.
// Caminho + senha vêm SEMPRE das variáveis de ambiente do utilizador (nunca do repo).
const PFX_PATH = process.env.DETRAN_PFX_PATH?.trim();
const PFX_PASS = process.env.DETRAN_PFX_PASS ?? "";
const tmpParaLimpar: string[] = [];

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
 * moderno num ficheiro temporário (apagado ao sair). Devolve o caminho do .pfx
 * utilizável; se não der para converter, devolve o original.
 */
function prepararPfxModerno(pfxPath: string, pass: string): string {
  const ssl = acharOpenssl();
  if (!ssl) return pfxPath;
  const pem = path.join(os.tmpdir(), `lanza_pfx_${process.pid}.pem`);
  const modern = path.join(os.tmpdir(), `lanza_pfx_${process.pid}.pfx`);
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
// Origens onde o gov.br pede o certificado de cliente (mTLS).
const CERT_ORIGINS = [
  "https://certificado.sso.acesso.gov.br",
  "https://sso.acesso.gov.br",
];

const cap: { auth?: string; empresa?: string; appVersion?: string } = {};
let authPrinted = false;

function persistAuth(): void {
  fs.writeFileSync(AUTH_FILE, JSON.stringify(cap, null, 2), "utf8");
  if (cap.auth && !authPrinted) {
    authPrinted = true;
    // Sentinela para o agente: NÃO imprime o token, só metadados.
    console.log(
      `CAPTURA_OK auth=${cap.auth.length}c empresa=${cap.empresa ?? "?"} appVersion=${cap.appVersion ?? "?"} file=${AUTH_FILE}`,
    );
  }
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

/** Tenta avançar o fluxo do gov.br clicando nos elementos prováveis (resiliente). */
async function avancarGovBr(page: import("playwright-core").Page, captured: () => boolean): Promise<void> {
  const padroes = [
    /entrar com gov\.br/i,
    /seu certificado digital/i,
    /certificado digital/i,
    /^entrar$/i,
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

async function main(): Promise<void> {
  fs.mkdirSync(RESP_DIR, { recursive: true });
  const browser = await launch();
  // Modo "os": NÃO usa o client-certificate do Playwright (que faz um proxy TLS
  // interno e dá `read ECONNRESET` nesta rede). Em vez disso, o Chrome nativo
  // apresenta o certificado do repositório do Windows (TLS tratado pelo browser).
  const osCert = process.argv.includes("--os-cert");
  let clientCertificates:
    | { origin: string; pfxPath: string; passphrase: string }[]
    | undefined;
  if (osCert) {
    console.log("Modo certificado do SO: o Chrome usará o certificado do repositório do Windows (sem proxy do Playwright).");
  } else if (PFX_PATH && fs.existsSync(PFX_PATH)) {
    const pfxUsavel = prepararPfxModerno(PFX_PATH, PFX_PASS);
    clientCertificates = CERT_ORIGINS.map((origin) => ({
      origin,
      pfxPath: pfxUsavel,
      passphrase: PFX_PASS,
    }));
  } else if (PFX_PATH) {
    console.error(`AVISO: .pfx não encontrado em ${PFX_PATH} — seguindo com login manual.`);
  } else {
    console.error(
      "AVISO: defina DETRAN_PFX_PATH e DETRAN_PFX_PASS nas variáveis de ambiente do utilizador para login automático.",
    );
  }
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, clientCertificates });
  const page = await ctx.newPage();

  ctx.on("request", (req) => {
    const url = req.url();
    if (!url.includes(API_HOST)) return;
    const h = req.headers();
    const auth = h["authorization"];
    if (auth && /^Bearer\s/i.test(auth)) {
      cap.auth = auth;
      if (h["x-empresa"]) cap.empresa = h["x-empresa"];
      if (h["x-app-version"]) cap.appVersion = h["x-app-version"];
      persistAuth();
    }
  });

  ctx.on("response", async (res) => {
    const url = res.url();
    if (!url.includes(API_HOST) || !/\/veiculo\/resposta-consulta\?/.test(url)) return;
    try {
      const txt = await res.text();
      const data = JSON.parse(txt) as Record<string, any>;
      const placa = String(data?.placa ?? data?.veiculo?.placa ?? "")
        .replace(/\W/g, "")
        .toUpperCase();
      if (placa) {
        const f = path.join(RESP_DIR, `${placa}.json`);
        fs.writeFileSync(f, txt, "utf8");
        console.log(`[veiculo] ${placa} salvo`);
      }
    } catch {
      /* respostas ainda em processamento / não-JSON */
    }
  });

  await page.goto(PORTAL, { waitUntil: "domcontentloaded" }).catch(() => {});
  console.log(
    clientCertificates
      ? "Navegador aberto com certificado A1 embarcado. Automatizando login gov.br..."
      : "Navegador aberto. Faça login com o certificado A1 (gov.br) e consulte os veículos.",
  );
  console.log("Ao terminar, FECHE a janela do navegador para finalizar (timeout: 15 min).");

  const manual = process.argv.includes("--manual");
  if (clientCertificates && !manual) {
    await avancarGovBr(page, () => !!cap.auth).catch(() => {});
    if (!cap.auth) {
      console.log("Login automático não concluiu sozinho — finalize/clique manualmente na janela; a captura segue ativa.");
    }
  } else if (manual) {
    console.log("Modo manual: clique no login gov.br e consulte os veículos; eu capturo automaticamente.");
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 15 * 60 * 1000);
    browser.on("disconnected", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  await browser.close().catch(() => {});
  for (const f of tmpParaLimpar) fs.rmSync(f, { force: true });
  const respostas = fs.existsSync(RESP_DIR) ? fs.readdirSync(RESP_DIR).filter((f) => f.endsWith(".json")) : [];
  console.log(`FIM. token=${cap.auth ? "OK" : "não capturado"} | veículos salvos: ${respostas.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
