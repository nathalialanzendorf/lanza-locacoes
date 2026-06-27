/**
 * Captura passiva (CDP) do token DETRAN SC a partir de um Edge NORMAL.
 *
 * Por que assim: o Cloudflare Turnstile do portal recusa navegadores
 * automatizados (Playwright/Selenium → `navigator.webdriver=true`). Aqui o Edge
 * é aberto como um navegador comum (só com a porta de depuração) e nós apenas
 * "ouvimos" a rede via CDP, habilitando somente o domínio Network — sem injetar
 * automação. O login (certificado A1) e o captcha são feitos por você, no browser.
 *
 * Captura, de chamadas a backend.detran.sc.gov.br/transito-api:
 *   - Authorization (Bearer)  -> DETRAN_SC_AUTH
 *   - X-Empresa               -> DETRAN_SC_EMPRESA
 *   - X-App-Version           -> DETRAN_SC_APP_VERSION
 *   - tickets `resposta-consulta?t=...` (com a placa do `requisitar-consulta?p=`)
 *
 * Uso: npx tsx scripts/capturarDetranCdp.ts
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const PORT = 9222;
const PORTAL = "https://servicos.detran.sc.gov.br/";
const API_HOST = "backend.detran.sc.gov.br";
const OUT_FILE = path.join(os.tmpdir(), "detran_capture.json");
// Perfil DEDICADO (não conflita com o Chrome principal e mantém a porta de
// depuração estável — o perfil padrão faz o Chrome se reiniciar e perder a flag).
// O certificado A1 vem do repositório do Windows, então o login é rápido.
const USER_DATA_DIR =
  process.env.CHROME_USER_DATA_DIR ?? path.join(os.tmpdir(), "lanza_chrome_detran");

const CHROME_CANDS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  path.join(os.homedir(), "AppData/Local/Google/Chrome/Application/chrome.exe"),
];

type Ticket = { placa: string; ticket: string };
const cap: { auth?: string; empresa?: string; appVersion?: string; tickets: Ticket[] } = {
  tickets: [],
};
let authPrinted = false;
let lastPlaca = "";

function persist(): void {
  fs.writeFileSync(OUT_FILE, JSON.stringify(cap, null, 2), "utf8");
  if (cap.auth && !authPrinted) {
    authPrinted = true;
    console.log(
      `CAPTURA_OK auth=${cap.auth.length}c empresa=${cap.empresa ?? "?"} appVersion=${cap.appVersion ?? "?"} file=${OUT_FILE}`,
    );
  }
}

function acharChrome(): string {
  for (const c of CHROME_CANDS) if (fs.existsSync(c)) return c;
  return "chrome";
}

async function devtoolsUp(): Promise<string | undefined> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    if (r.ok) {
      const j = (await r.json()) as { webSocketDebuggerUrl?: string };
      return j.webSocketDebuggerUrl;
    }
  } catch {
    /* não está em pé */
  }
  return undefined;
}


async function esperarDevtools(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) {
        const j = (await r.json()) as { webSocketDebuggerUrl?: string };
        if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
      }
    } catch {
      /* ainda subindo */
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error("DevTools não respondeu na porta de depuração.");
}

function lerHeader(headers: Record<string, string>, nome: string): string | undefined {
  const alvo = nome.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === alvo) return v;
  }
  return undefined;
}

function tratarRequest(url: string, headers: Record<string, string>): void {
  if (!url.includes(API_HOST)) return;

  const auth = lerHeader(headers, "authorization");
  if (auth && /^Bearer\s/i.test(auth)) {
    cap.auth = auth;
    const emp = lerHeader(headers, "x-empresa");
    const ver = lerHeader(headers, "x-app-version");
    if (emp) cap.empresa = emp;
    if (ver) cap.appVersion = ver;
    persist();
  }

  const mReq = url.match(/\/veiculo\/requisitar-consulta\?[^]*?[?&]p=([A-Za-z0-9-]+)/);
  if (mReq) lastPlaca = mReq[1]!.toUpperCase();

  const mResp = url.match(/\/veiculo\/resposta-consulta\?t=([0-9a-fA-F-]{36})/);
  if (mResp) {
    const ticket = mResp[1]!;
    if (!cap.tickets.some((t) => t.ticket === ticket)) {
      cap.tickets.push({ placa: lastPlaca || "?", ticket });
      console.log(`[ticket] placa=${lastPlaca || "?"} t=${ticket}`);
      persist();
    }
  }
}

async function main(): Promise<void> {
  let wsUrl = await devtoolsUp();
  if (!wsUrl) {
    const chrome = acharChrome();
    const child = spawn(
      chrome,
      [
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${USER_DATA_DIR}`,
        "--no-first-run",
        "--no-default-browser-check",
        PORTAL,
      ],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    wsUrl = await esperarDevtools();
  }
  console.log("Chrome (janela dedicada) aberto. Faça login com o certificado A1 e consulte os veículos.");
  console.log("O captcha funciona porque NÃO é automatizado. Feche essa janela para finalizar (timeout 15 min).");

  const ws = new WebSocket(wsUrl);
  let msgId = 1;
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    ws.send(JSON.stringify({ id: msgId++, method, params, sessionId }));
  };

  ws.on("open", () => {
    // Anexa a todos os alvos (páginas) e habilita SÓ o domínio Network.
    send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  });

  ws.on("message", (data: WebSocket.RawData) => {
    let msg: any;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.method === "Target.attachedToTarget") {
      const sid = msg.params?.sessionId as string | undefined;
      if (sid) send("Network.enable", {}, sid);
    } else if (msg.method === "Network.requestWillBeSent") {
      const req = msg.params?.request;
      if (req?.url) tratarRequest(req.url as string, (req.headers ?? {}) as Record<string, string>);
    }
  });

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 15 * 60 * 1000);
    const poll = setInterval(() => {
      // Encerra quando o Edge fechar (DevTools deixa de responder).
      fetch(`http://127.0.0.1:${PORT}/json/version`).catch(() => {
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      });
    }, 4000);
  });

  try {
    ws.close();
  } catch {
    /* ignore */
  }
  console.log(
    `FIM. token=${cap.auth ? "OK" : "não capturado"} | empresa=${cap.empresa ?? "?"} | tickets=${cap.tickets.length}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
