/**
 * Harness de Chrome REAL (via CDP) para a triagem de locatário.
 *
 * Mesma filosofia do solver do DETRAN SC (`scripts/detranSolver.ts`): abrimos um
 * Chrome NATIVO com a porta de depuração e o "dirigimos" por CDP. Como o browser
 * é real e na origem correta, captchas (reCAPTCHA do PF / BNMP) e o login gov.br
 * (TJSC) funcionam — o operador resolve o captcha/login UMA vez na janela e nós
 * capturamos os dados.
 *
 * O que este módulo oferece (genérico, reusável pelos 3 portais):
 *   - `iniciar()`      sobe o Chrome (perfil dedicado + pasta de downloads).
 *   - `novaAba(url)`   abre uma aba e devolve o `sessionId` (CDP flatten).
 *   - `avaliar(expr)`  executa JS na aba (com o hook `browserHook` injetado).
 *   - captura de RESPOSTAS de rede por substring de URL (ex.: a busca do BNMP).
 *   - captura de DOWNLOADS (ex.: o PDF da certidão do PF).
 *   - `fechar()`       encerra o navegador (best-effort).
 *
 * Não depende de Playwright — só do Chrome instalado + `ws` (já no projeto).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import WebSocket from "ws";

import { REPO_ROOT } from "../repoRoot.js";
import { TRIAGEM_BROWSER_HOOK } from "./browserHook.js";

const PORT = Number(process.env.TRIAGEM_CHROME_PORT) || 9333;
const USER_DATA_DIR =
  process.env.TRIAGEM_CHROME_USER_DATA_DIR ??
  path.join(os.tmpdir(), "lanza_chrome_triagem");
const DOWNLOAD_DIR = path.join(REPO_ROOT, "relatorios", "_tmp", "triagem", "downloads");

const CHROME_CANDS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  path.join(os.homedir(), "AppData/Local/Google/Chrome/Application/chrome.exe"),
];

function acharChrome(): string {
  for (const c of CHROME_CANDS) if (fs.existsSync(c)) return c;
  return "chrome";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface RespostaCapturada {
  url: string;
  status: number;
  mimeType: string;
  body: string;
  base64: boolean;
  sessionId: string;
  ts: number;
}

export interface DownloadCapturado {
  guid: string;
  suggestedFilename: string;
  url: string;
  caminho: string;
  ts: number;
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
    timeoutMs = 15000,
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
    timeoutMs = 15000,
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

async function chromeVivoPort(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return r.ok;
  } catch {
    return false;
  }
}

export class TriagemBrowser {
  private cdp: Cdp;
  private ws: WebSocket;
  private sessions = new Map<string, { type: string; url: string; targetId: string }>();
  /** requestId (por sessão) → metadados, p/ buscar o corpo no loadingFinished. */
  private reqMeta = new Map<string, { url: string; status: number; mimeType: string; sessionId: string }>();
  private substringsAlvo: string[] = [];
  private respostas: RespostaCapturada[] = [];
  private downloads: DownloadCapturado[] = [];
  private fechado = false;

  readonly downloadDir = DOWNLOAD_DIR;

  private constructor(ws: WebSocket, cdp: Cdp) {
    this.ws = ws;
    this.cdp = cdp;
  }

  static async iniciar(): Promise<TriagemBrowser> {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

    if (!(await chromeVivoPort())) {
      const chrome = acharChrome();
      const child = spawn(
        chrome,
        [
          `--remote-debugging-port=${PORT}`,
          `--user-data-dir=${USER_DATA_DIR}`,
          "--no-first-run",
          "--no-default-browser-check",
          "about:blank",
        ],
        { detached: true, stdio: "ignore" },
      );
      child.unref();
    }
    const wsUrl = await esperarDevtools();
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.on("error", (e) => console.error(`[ws] erro: ${(e as Error)?.message ?? e}`));

    const cdp = new Cdp(ws);
    const inst = new TriagemBrowser(ws, cdp);
    await inst.configurar();
    return inst;
  }

  private async configurar(): Promise<void> {
    this.cdp.onEvent((m) => this.aoEvento(m));

    // Downloads em pasta conhecida, nomeados pelo guid (allowAndName) → simples
    // de localizar e parsear (ex.: o PDF do PF SINIC).
    await this.cdp
      .send("Browser.setDownloadBehavior", {
        behavior: "allowAndName",
        downloadPath: DOWNLOAD_DIR,
        eventsEnabled: true,
      })
      .catch(() => {});

    await this.cdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
  }

  private aoEvento(m: any): void {
    const sid = m.sessionId as string | undefined;
    if (m.method === "Target.attachedToTarget") {
      const nsid = m.params?.sessionId as string;
      const info = m.params?.targetInfo ?? {};
      this.sessions.set(nsid, {
        type: info.type ?? "",
        url: info.url ?? "",
        targetId: info.targetId ?? "",
      });
      // Configura a aba ANTES de liberar (igual ao DETRAN): Network/Runtime +
      // skip de pauses anti-debug + injeção do hook em todo novo documento.
      void (async () => {
        try {
          await this.cdp.send("Network.enable", {}, nsid);
          await this.cdp.send("Page.enable", {}, nsid);
          await this.cdp.send("Runtime.enable", {}, nsid);
          await this.cdp.send("Debugger.enable", {}, nsid);
          await this.cdp.send("Debugger.setSkipAllPauses", { skip: true }, nsid);
          await this.cdp.send(
            "Page.addScriptToEvaluateOnNewDocument",
            { source: TRIAGEM_BROWSER_HOOK },
            nsid,
          );
        } catch {
          /* segue mesmo se algum enable falhar */
        } finally {
          this.cdp.send("Runtime.runIfWaitingForDebugger", {}, nsid).catch(() => {});
        }
      })();
    } else if (m.method === "Debugger.paused") {
      if (sid) this.cdp.send("Debugger.resume", {}, sid).catch(() => {});
    } else if (m.method === "Target.targetInfoChanged") {
      const info = m.params?.targetInfo;
      if (info?.targetId) {
        for (const s of this.sessions.values()) {
          if (s.targetId === info.targetId) s.url = info.url ?? s.url;
        }
      }
    } else if (m.method === "Target.detachedFromTarget") {
      const dsid = m.params?.sessionId as string | undefined;
      if (dsid) this.sessions.delete(dsid);
    } else if (m.method === "Network.responseReceived") {
      const r = m.params?.response ?? {};
      const reqId = m.params?.requestId as string;
      if (reqId) {
        this.reqMeta.set(`${sid}:${reqId}`, {
          url: r.url ?? "",
          status: r.status ?? 0,
          mimeType: r.mimeType ?? "",
          sessionId: sid ?? "",
        });
      }
    } else if (m.method === "Network.loadingFinished") {
      const reqId = m.params?.requestId as string;
      const key = `${sid}:${reqId}`;
      const meta = this.reqMeta.get(key);
      if (meta && this.urlInteressa(meta.url)) {
        void this.coletarCorpo(reqId, meta);
      }
      if (meta) this.reqMeta.delete(key);
    } else if (m.method === "Browser.downloadWillBegin") {
      const p = m.params ?? {};
      this.downloads.push({
        guid: p.guid ?? "",
        suggestedFilename: p.suggestedFilename ?? "",
        url: p.url ?? "",
        caminho: p.guid ? path.join(DOWNLOAD_DIR, p.guid) : "",
        ts: Date.now(),
      });
    } else if (m.method === "Browser.downloadProgress") {
      const p = m.params ?? {};
      const d = this.downloads.find((x) => x.guid === p.guid);
      if (d && p.state === "completed") {
        // arquivo finalizado em DOWNLOAD_DIR/<guid>
        d.caminho = path.join(DOWNLOAD_DIR, d.guid);
      }
    }
  }

  private urlInteressa(url: string): boolean {
    if (!this.substringsAlvo.length) return false;
    return this.substringsAlvo.some((s) => url.includes(s));
  }

  private async coletarCorpo(
    reqId: string,
    meta: { url: string; status: number; mimeType: string; sessionId: string },
  ): Promise<void> {
    try {
      const r = await this.cdp.send(
        "Network.getResponseBody",
        { requestId: reqId },
        meta.sessionId,
      );
      this.respostas.push({
        url: meta.url,
        status: meta.status,
        mimeType: meta.mimeType,
        body: r?.body ?? "",
        base64: !!r?.base64Encoded,
        sessionId: meta.sessionId,
        ts: Date.now(),
      });
    } catch {
      /* corpo pode ter sido descartado pelo Chrome */
    }
  }

  /** Define as substrings de URL cujas respostas devem ser capturadas. */
  capturarRespostas(substrings: string[]): void {
    this.substringsAlvo = substrings.slice();
  }

  limparCapturas(): void {
    this.respostas = [];
  }

  respostasCapturadas(filtro?: string): RespostaCapturada[] {
    return filtro
      ? this.respostas.filter((r) => r.url.includes(filtro))
      : this.respostas.slice();
  }

  /** Aguarda (poll) até capturar uma resposta cujo URL contenha `substr`. */
  async esperarResposta(
    substr: string,
    timeoutMs: number,
  ): Promise<RespostaCapturada | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const achada = this.respostas.find((r) => r.url.includes(substr));
      if (achada) return achada;
      if (!(await this.vivo())) return null;
      await sleep(1000);
    }
    return null;
  }

  /** Aguarda um download concluído (devolve o mais recente). */
  async esperarDownload(timeoutMs: number): Promise<DownloadCapturado | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const concluido = [...this.downloads]
        .reverse()
        .find((d) => d.caminho && fs.existsSync(d.caminho));
      if (concluido) return concluido;
      if (!(await this.vivo())) return null;
      await sleep(1000);
    }
    return null;
  }

  /** Abre uma nova aba no URL e devolve o sessionId quando ela anexar. */
  async novaAba(url: string): Promise<string> {
    let ultimoErro: unknown;
    // Até 2 tentativas: criar target logo após fechar outra aba pode falhar de
    // forma transitória (corrida no autoAttach).
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      try {
        const { targetId } = await this.cdp.send("Target.createTarget", { url });
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          for (const [sid, s] of this.sessions) {
            if (s.targetId === targetId) return sid;
          }
          if (!(await this.vivo())) break;
          await sleep(200);
        }
        ultimoErro = new Error("attach não chegou em 15s");
      } catch (e) {
        ultimoErro = e;
      }
      await sleep(800);
    }
    throw new Error(
      `Não consegui anexar à nova aba: ${ultimoErro instanceof Error ? ultimoErro.message : String(ultimoErro)}`,
    );
  }

  async navegar(sessionId: string, url: string): Promise<void> {
    await this.cdp.send("Page.navigate", { url }, sessionId);
  }

  /**
   * Fecha a aba (target) de uma fonte — chamado assim que o captcha é resolvido
   * e o resultado já foi capturado, para não deixar a janela pendurada. O corpo
   * da resposta / PDF já está guardado, então fechar aqui é seguro.
   */
  async fecharAba(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (!s?.targetId) return;
    try {
      await this.cdp.send("Target.closeTarget", { targetId: s.targetId });
    } catch {
      /* best-effort */
    }
    this.sessions.delete(sessionId);
  }

  async avaliar<T = unknown>(
    expression: string,
    sessionId: string,
    timeoutMs = 15000,
  ): Promise<T> {
    return this.cdp.evaluate<T>(expression, sessionId, timeoutMs);
  }

  /** Reinjeta o hook na aba (caso a SPA tenha navegado/recarregado). */
  async reinjetarHook(sessionId: string): Promise<void> {
    await this.cdp.evaluate(TRIAGEM_BROWSER_HOOK, sessionId).catch(() => {});
  }

  /** Preenche um campo (setter nativo + eventos) — bom p/ texto simples. */
  async preencher(sessionId: string, seletor: string, valor: string): Promise<boolean> {
    const expr = `window.__triagemPreencher(${JSON.stringify(seletor)}, ${JSON.stringify(valor)})`;
    return (await this.avaliar<boolean>(expr, sessionId).catch(() => false)) === true;
  }

  /** Digita tecla-a-tecla — bom p/ campos com máscara (CPF) ou date picker. */
  async digitar(sessionId: string, seletor: string, texto: string): Promise<boolean> {
    const expr = `window.__triagemDigitar(${JSON.stringify(seletor)}, ${JSON.stringify(texto)})`;
    return (await this.avaliar<boolean>(expr, sessionId).catch(() => false)) === true;
  }

  /** Clica no 1º elemento cujo texto bata algum dos padrões (regex). */
  async clicarTexto(sessionId: string, padroes: string[]): Promise<string | null> {
    const expr = `window.__triagemClick(${JSON.stringify(padroes)})`;
    return (await this.avaliar<string | null>(expr, sessionId).catch(() => null)) ?? null;
  }

  /** true quando o reCAPTCHA da aba já foi resolvido (token presente). */
  async recaptchaResolvido(sessionId: string): Promise<boolean> {
    return (
      (await this.avaliar<boolean>("window.__triagemRecaptchaOk()", sessionId).catch(
        () => false,
      )) === true
    );
  }

  /** Lê o value atual de um campo (conferência/diagnóstico). */
  async valorDe(sessionId: string, seletor: string): Promise<string | null> {
    const expr = `window.__triagemValor(${JSON.stringify(seletor)})`;
    return (await this.avaliar<string | null>(expr, sessionId).catch(() => null)) ?? null;
  }

  /** Preenche o campo cujo rótulo casa o regex (forms sem id estável). */
  async preencherPorRotulo(
    sessionId: string,
    rotuloRegex: string,
    valor: string,
  ): Promise<{ ok: boolean; rotulo?: string; valor?: string }> {
    const expr = `window.__triagemPreencherPorRotulo(${JSON.stringify(rotuloRegex)}, ${JSON.stringify(valor)})`;
    return (
      (await this.avaliar<{ ok: boolean; rotulo?: string; valor?: string }>(expr, sessionId).catch(
        () => ({ ok: false }),
      )) ?? { ok: false }
    );
  }

  /** Snapshot leve da tela (textos clicáveis + campos) para diagnóstico. */
  async snapshot(sessionId: string): Promise<string> {
    return (
      (await this.avaliar<string>("window.__triagemSnapshot()", sessionId).catch(
        () => "{}",
      )) ?? "{}"
    );
  }

  /** Espera até a condição (expr JS booleana) ser verdadeira, ou timeout. */
  async esperarCondicao(
    sessionId: string,
    exprBool: string,
    timeoutMs: number,
    intervaloMs = 1000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ok = await this.avaliar<boolean>(`!!(${exprBool})`, sessionId).catch(() => false);
      if (ok === true) return true;
      if (!(await this.vivo())) return false;
      await sleep(intervaloMs);
    }
    return false;
  }

  async hostDe(sessionId: string): Promise<string> {
    try {
      return (await this.cdp.evaluate<string>("location.host", sessionId)) || "";
    } catch {
      return "";
    }
  }

  async vivo(): Promise<boolean> {
    if (this.fechado) return false;
    return chromeVivoPort();
  }

  async fechar(): Promise<void> {
    if (this.fechado) return;
    this.fechado = true;
    try {
      await this.cdp.send("Browser.close", {}, undefined, 5000);
    } catch {
      /* best-effort */
    }
    try {
      this.ws.close();
    } catch {
      /* já fechado */
    }
  }
}
