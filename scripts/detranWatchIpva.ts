/**
 * WATCHER de IPVA no DETRAN SC — consulta UMA placa a cada N minutos e avisa
 * quando o IPVA for RETIRADO do sistema (deixar de aparecer nos `debitos`).
 *
 * Reaproveita o mesmo mecanismo do solver (Chrome real via CDP + Turnstile):
 * abre o Chrome UMA vez, você faz o login gov.br UMA vez, e a janela fica aberta
 * enquanto o watcher repete a consulta no intervalo escolhido — sem reabrir o
 * navegador nem pedir login a cada ciclo.
 *
 * Uso:
 *   npx tsx scripts/detranWatchIpva.ts --placa RYC-7C32 [--intervalo 5] [--continuar] [--dry-run]
 *     --placa PLACA     placa a monitorar (default: RYC-7C32, o Nivus)
 *     --intervalo MIN   minutos entre consultas (default: 5)
 *     --continuar       não para quando o IPVA sumir (default: para e fecha)
 *     --dry-run         (compat.) este watcher nunca grava em *-despesas.json
 *
 * Sentinela na saída (para automações/loop do agente):
 *   IPVA_RETIRADO_DO_SISTEMA placa=<PLACA>   → impresso quando o IPVA some.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import WebSocket from "ws";

import { extrairDespesasDetranSc } from "../src/lib/detranSc/mapDebitosProprietario.js";
import { loadVeiculosParaSync } from "../src/lib/detranSc/syncVeiculo.js";
import { compactPlaca, formatPlacaHyphen } from "../src/lib/placa.js";
import { DETRAN_BROWSER_HOOK } from "./detranBrowserHook.js";

const PORT = 9222;
const PORTAL = "https://servicos.detran.sc.gov.br/";
const API_HOST = "backend.detran.sc.gov.br";
const OUT_DIR = path.resolve("relatorios/_tmp/detran");
const DETRAN_SC_SITEKEY = "0x4AAAAAACHoBaRqG-bgkhK1";
const DETRAN_SC_ACTION =
  process.env.DETRAN_SC_TURNSTILE_ACTION?.trim() || "consulta_dossie_veiculo";
const USER_DATA_DIR =
  process.env.CHROME_USER_DATA_DIR ?? path.join(os.tmpdir(), "lanza_chrome_detran");
const DEBUG = process.env.DETRAN_SC_DEBUG === "1";

const CHROME_CANDS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  path.join(os.homedir(), "AppData/Local/Google/Chrome/Application/chrome.exe"),
];

type Cred = { auth?: string; empresa?: string; appVersion?: string };

function acharChrome(): string {
  for (const c of CHROME_CANDS) if (fs.existsSync(c)) return c;
  return "chrome";
}

function lerHeader(h: Record<string, string>, nome: string): string | undefined {
  const alvo = nome.toLowerCase();
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === alvo) return v;
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function agora(): string {
  return new Date().toLocaleTimeString("pt-BR", { hour12: false });
}

/** Cliente CDP mínimo com correlação id↔resposta e despacho de eventos. */
class Cdp {
  private id = 1;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private handlers: ((m: any) => void)[] = [];

  constructor(private ws: WebSocket) {
    ws.on("message", (data: WebSocket.RawData) => {
      let m: any;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (typeof m.id === "number" && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)!;
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message ?? "CDP error"));
        else p.resolve(m.result);
        return;
      }
      for (const h of this.handlers) {
        try {
          h(m);
        } catch {
          /* handler resiliente */
        }
      }
    });
  }

  onEvent(fn: (m: any) => void): void {
    this.handlers.push(fn);
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 12000,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params, sessionId }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  async evaluate<T = unknown>(
    expression: string,
    sessionId: string,
    timeoutMs = 12000,
  ): Promise<T> {
    const r = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
      timeoutMs,
    );
    if (r?.exceptionDetails) {
      const ex = r.exceptionDetails;
      const msg =
        ex.exception?.description ?? ex.exception?.value ?? ex.text ?? "erro JS";
      throw new Error(String(msg));
    }
    return r?.result?.value as T;
  }
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
    await sleep(500);
  }
  throw new Error("DevTools não respondeu na porta de depuração.");
}

async function chromeVivo(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return r.ok;
  } catch {
    return false;
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const placa = (get("--placa") ?? "RYC-7C32").toUpperCase();
  const intervaloMin = Math.max(1, Number(get("--intervalo") ?? "5") || 5);
  const continuar = args.includes("--continuar");
  return { placa, intervaloMin, continuar };
}

async function main(): Promise<void> {
  const { placa, intervaloMin, continuar } = parseArgs();

  // Resolve o veículo (renavam) na frota SC ativa. loadVeiculosParaSync lança
  // se a placa não existir / não for SC ativa.
  let veiculo;
  try {
    veiculo = loadVeiculosParaSync(placa)[0];
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  if (!veiculo) {
    console.error(
      `✗ Placa ${placa} não encontrada na frota SC ativa (verifique placa / ufRegistro / ativo).`,
    );
    process.exit(1);
  }
  const renavam = String(veiculo.renavam).replace(/\D/g, "");
  const placaApi = compactPlaca(placa);
  const placaFmt = formatPlacaHyphen(placa);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(
    `Watcher IPVA — placa ${placaFmt} | a cada ${intervaloMin} min | ` +
      `${continuar ? "continua" : "para"} ao sumir o IPVA\n`,
  );

  // 1) Garante o Chrome com a porta de depuração.
  let wsUrl: string;
  if (await chromeVivo()) {
    wsUrl = await esperarDevtools();
  } else {
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

  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  let wsFechado = false;
  ws.on("error", (e) => console.error(`[ws] erro: ${(e as Error)?.message ?? e}`));
  ws.on("close", () => {
    wsFechado = true;
  });
  const cdp = new Cdp(ws);

  let navegadorFechado = false;
  async function fecharNavegador(): Promise<void> {
    if (navegadorFechado) return;
    navegadorFechado = true;
    try {
      await cdp.send("Browser.close", {}, undefined, 5000);
    } catch {
      /* best-effort */
    }
    try {
      ws.close();
    } catch {
      /* já fechado */
    }
  }

  const cred: Cred = {};
  let sitekeyNet: string | null = null;
  const sessions = new Map<string, { type: string; url: string; targetId: string }>();

  cdp.onEvent((m) => {
    if (m.method === "Target.attachedToTarget") {
      const sid = m.params?.sessionId as string;
      const info = m.params?.targetInfo ?? {};
      sessions.set(sid, {
        type: info.type ?? "",
        url: info.url ?? "",
        targetId: info.targetId ?? "",
      });
      void (async () => {
        try {
          await cdp.send("Network.enable", {}, sid);
          await cdp.send("Page.enable", {}, sid);
          await cdp.send("Runtime.enable", {}, sid);
          await cdp.send("Debugger.enable", {}, sid);
          await cdp.send("Debugger.setSkipAllPauses", { skip: true }, sid);
          await cdp.send(
            "Page.addScriptToEvaluateOnNewDocument",
            { source: DETRAN_BROWSER_HOOK },
            sid,
          );
        } catch {
          /* segue mesmo se algum enable falhar */
        } finally {
          cdp.send("Runtime.runIfWaitingForDebugger", {}, sid).catch(() => {});
        }
      })();
    } else if (m.method === "Debugger.paused") {
      const psid = m.sessionId as string | undefined;
      if (psid) cdp.send("Debugger.resume", {}, psid).catch(() => {});
    } else if (m.method === "Target.targetInfoChanged") {
      const info = m.params?.targetInfo;
      if (info?.targetId) {
        for (const s of sessions.values()) {
          if (s.targetId === info.targetId) s.url = info.url ?? s.url;
        }
      }
    } else if (m.method === "Target.detachedFromTarget") {
      const sid = m.params?.sessionId as string | undefined;
      if (sid) sessions.delete(sid);
    } else if (m.method === "Network.requestWillBeSent") {
      const req = m.params?.request;
      const url: string = req?.url ?? "";
      if (!sitekeyNet && url.includes("challenges.cloudflare.com")) {
        const mm = url.match(/0x[0-9A-Za-z_-]{15,}/);
        if (mm) sitekeyNet = mm[0];
      }
      if (!url.includes(API_HOST)) return;
      const h = (req?.headers ?? {}) as Record<string, string>;
      const auth = lerHeader(h, "authorization");
      if (auth && /^Bearer\s/i.test(auth)) {
        cred.auth = auth;
        const emp = lerHeader(h, "x-empresa");
        const ver = lerHeader(h, "x-app-version");
        if (emp) cred.empresa = emp;
        if (ver) cred.appVersion = ver;
      }
    }
  });

  await cdp.send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });

  function pageSessions(): string[] {
    const out: string[] = [];
    for (const [sid, s] of sessions) if (s.type === "page") out.push(sid);
    return out;
  }

  function sessaoPortal(): string | undefined {
    for (const [sid, s] of sessions) {
      if (s.type === "page" && /(detran\.sc\.gov\.br|acesso\.gov\.br)/.test(s.url)) {
        return sid;
      }
    }
    for (const [sid, s] of sessions) if (s.type === "page") return sid;
    return undefined;
  }

  async function hostDe(sid: string): Promise<string> {
    try {
      return (await cdp.evaluate<string>("location.host", sid)) || "";
    } catch {
      return "";
    }
  }

  console.log("Chrome aberto. Faça o LOGIN gov.br na janela e deixe-a aberta.");
  console.log("Não precisa consultar manualmente — o watcher cuida do captcha.\n");

  // 2) Espera credenciais + sitekey + aba do portal (login). Timeout 8 min.
  const TIMEOUT_MIN = 8;
  const deadline = Date.now() + TIMEOUT_MIN * 60 * 1000;
  let sid: string | undefined;
  let sitekey: string | null = null;
  let proximoHeartbeat = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!(await chromeVivo())) {
      console.error("Janela do Chrome fechada antes do login. Abortado.");
      process.exit(1);
    }
    if (wsFechado) {
      console.error("[ws] socket de depuração fechado. Reinicie o watcher.");
      process.exit(1);
    }

    if (Date.now() >= proximoHeartbeat) {
      proximoHeartbeat = Date.now() + 30_000;
      const restante = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      console.log(`  … aguardando login gov.br (login=${cred.auth ? "ok" : "-"}, ${restante}s)`);
    }

    for (const ps of pageSessions()) {
      await cdp.evaluate(DETRAN_BROWSER_HOOK, ps).catch(() => {});
      const host = await hostDe(ps);
      const noDetran = /detran\.sc\.gov\.br/.test(host);
      if (noDetran) {
        const env = process.env.DETRAN_SC_TURNSTILE_SITEKEY?.trim();
        sitekey = env || sitekeyNet || DETRAN_SC_SITEKEY;
        sid = ps;
      }
      if (!cred.auth) {
        const tok = await cdp
          .evaluate<string | null>(
            "window.__lanzaScanToken ? window.__lanzaScanToken() : null",
            ps,
          )
          .catch(() => null);
        if (tok) cred.auth = `Bearer ${tok}`;
      }
    }

    if (!sid) sid = sessaoPortal();
    if (cred.auth && sid && sitekey) break;
    await sleep(2500);
  }

  if (!cred.auth || !sid || !sitekey) {
    console.error("✗ Não capturei login/sitekey a tempo. Faça o login no portal e tente de novo.");
    await fecharNavegador();
    process.exit(1);
  }
  console.log(
    `✓ Login OK (empresa=${cred.empresa ?? "?"}) | sitekey=${sitekey.slice(0, 10)}…\n`,
  );

  // 3) Consulta uma vez e devolve a lista de IPVA encontrada (ou null em erro).
  async function consultarIpva(): Promise<
    { ipvas: ReturnType<typeof extrairDespesasDetranSc>["despesas"] } | { erro: string }
  > {
    try {
      const token = await cdp.evaluate<string>(
        `window.__lanzaMint(${JSON.stringify(sitekey)}, ${JSON.stringify(DETRAN_SC_ACTION)})`,
        sid!,
      );
      const res = await cdp.evaluate<any>(
        `window.__lanzaConsulta(${JSON.stringify({
          placa: placaApi,
          renavam,
          captcha: token,
          auth: cred.auth,
          empresa: cred.empresa,
          appVersion: cred.appVersion,
        })})`,
        sid!,
        60000,
      );
      if (DEBUG) console.error(`[debug] →`, JSON.stringify(res).slice(0, 300));
      if (!res || res.status !== "ok" || !res.payload) {
        return { erro: res?.message ?? "sem payload" };
      }
      fs.writeFileSync(
        path.join(OUT_DIR, `${placaApi}.json`),
        JSON.stringify(res.payload, null, 2),
        "utf8",
      );
      const { despesas } = extrairDespesasDetranSc(placa, res.payload);
      const ipvas = despesas.filter((d) => d.categoria === "IPVA");
      return { ipvas };
    } catch (e) {
      return { erro: e instanceof Error ? e.message : String(e) };
    }
  }

  // 4) Loop de consultas.
  let ciclo = 0;
  for (;;) {
    ciclo++;
    if (!(await chromeVivo()) || wsFechado) {
      console.error(`[${agora()}] janela do Chrome fechada — encerrando watcher.`);
      break;
    }

    const r = await consultarIpva();
    if ("erro" in r) {
      console.log(`[${agora()}] #${ciclo} ✗ falha na consulta: ${r.erro} (tenta de novo no próximo ciclo)`);
    } else if (r.ipvas.length === 0) {
      console.log(`[${agora()}] #${ciclo} ✓ IPVA AUSENTE — não há mais débito de IPVA no sistema.`);
      console.log(`IPVA_RETIRADO_DO_SISTEMA placa=${placaFmt}`);
      if (!continuar) {
        console.log("Encerrando watcher (IPVA retirado). Use --continuar para manter monitorando.");
        break;
      }
    } else {
      const resumo = r.ipvas
        .map((d) => `${d.descricao} venc ${d.data} R$ ${d.valor.toFixed(2)}`)
        .join("; ");
      console.log(`[${agora()}] #${ciclo} • IPVA PRESENTE (${r.ipvas.length}): ${resumo}`);
    }

    await sleep(intervaloMin * 60 * 1000);
  }

  await fecharNavegador();
  console.log("Navegador fechado.");
}

process.on("unhandledRejection", (e) => {
  console.error("[unhandledRejection]", e instanceof Error ? e.message : e);
});
process.on("uncaughtException", (e) => {
  console.error("[uncaughtException]", e instanceof Error ? e.message : e);
});

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
