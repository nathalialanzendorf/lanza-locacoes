/**
 * LOGIN + SOLVER DE CAPTCHA do DETRAN SC, num Chrome REAL controlado por CDP.
 *
 * Por que funciona: o Cloudflare Turnstile recusa navegadores AUTOMATIZADOS
 * (Playwright/Selenium → navigator.webdriver=true). Aqui o Chrome é nativo — só
 * o "ouvimos"/dirigimos pela porta de depuração (CDP). Como a página é real e na
 * origem correta, o Turnstile emite tokens válidos que o backend aceita.
 *
 * Fluxo:
 *   1. Abre o Chrome (perfil dedicado) no portal. Você faz o login gov.br (cert
 *      A1 do repositório do Windows é apresentado quase automaticamente) e abre
 *      UMA vez a tela de consulta de veículo — assim o portal renderiza o widget
 *      Turnstile e capturamos o sitekey. A partir daí é automático.
 *   2. Capturamos da rede o JWT (Authorization), X-Empresa e X-App-Version.
 *   3. Para cada veículo ATIVO/SC da frota: minamos um token Turnstile fresco no
 *      próprio browser e chamamos requisitar-consulta?...&c=<token> +
 *      resposta-consulta, gravando o payload.
 *   4. Ingestão: INFRAÇÕES (cliente-despesas) + IPVA/LICENCIAMENTO
 *      (parceiro-despesas), reusando os processadores existentes.
 *   5. SEMPRE fecha o navegador (Browser.close) após capturar os dados — tanto
 *      na varredura completa quanto no modo --so-token.
 *
 * Uso:
 *   npx tsx scripts/detranSolver.ts [--placa PLACA] [--dry-run] [--so-token]
 *     --placa PLACA   processa só essa placa
 *     --dry-run       não grava nos *-despesas.json (só relata)
 *     --so-token      só mina e imprime metadados de um token (para usar com
 *                     `sync-infracoes --captcha <c> --placa PLACA`)
 *
 * Env opcionais:
 *   DETRAN_SC_TURNSTILE_SITEKEY  crava o sitekey (pula a auto-descoberta)
 *   CHROME_USER_DATA_DIR         perfil do Chrome (default: tmp dedicado)
 *   DETRAN_SC_DEBUG=1            loga respostas cruas
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import WebSocket from "ws";

import { processarDespesasDetranSc } from "../src/lib/detranSc/syncDespesasVeiculo.js";
import {
  loadVeiculosParaSync,
  processarRespostaDetranSc,
} from "../src/lib/detranSc/syncVeiculo.js";
import { compactPlaca } from "../src/lib/placa.js";
import { DETRAN_BROWSER_HOOK } from "./detranBrowserHook.js";

const PORT = 9222;
const PORTAL = "https://servicos.detran.sc.gov.br/";
const API_HOST = "backend.detran.sc.gov.br";
const OUT_DIR = path.resolve("relatorios/_tmp/detran");
// Sitekey do Turnstile do portal DETRAN SC (extraído do bundle index-*.js;
// estático para o site). Serve de default; pode ser sobreposto por env
// (DETRAN_SC_TURNSTILE_SITEKEY) ou pela captura de rede, se o portal o trocar.
const DETRAN_SC_SITEKEY = "0x4AAAAAACHoBaRqG-bgkhK1";
// Action que o portal usa no Turnstile para o dossiê de veículo (infrações +
// débitos). Extraído do chunk ConsultaDossieVeiculo-*.js: $turnstile("consulta_dossie_veiculo").
// O backend valida o action; minar sem ele dava "Captcha inválido".
const DETRAN_SC_ACTION = process.env.DETRAN_SC_TURNSTILE_ACTION?.trim() || "consulta_dossie_veiculo";
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

/**
 * Setup gratuito do login por certificado A1: importa o .pfx em
 * Cert:\CurrentUser\My e define a política do Chrome AutoSelectCertificateForUrls
 * (HKCU, sem admin), para o Chrome apresentar o certificado sozinho no gov.br.
 */
function runCertSetup(): void {
  const ps1 = path.resolve("scripts/detranCertSetup.ps1");
  if (process.platform !== "win32") {
    console.log("(setup de certificado é específico do Windows — pulado)");
    return;
  }
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1],
      { encoding: "utf8" },
    );
    process.stdout.write(out);
  } catch (e) {
    console.error(
      "AVISO: setup de certificado falhou:",
      e instanceof Error ? e.message : String(e),
    );
  }
}

// Padrões de texto para dirigir o login gov.br (Entrar → certificado digital) e,
// depois, abrir a tela de consulta de veículo. Best-effort e idempotente.
const LOGIN_PATTERNS = [
  "entrar com gov",
  "acessar o portal via gov",
  "acessar.*gov\\.br",
  "via gov\\.br",
  "seu certificado digital",
  "login com certificado",
  "certificado digital",
  "certificado",
  "outras opc",
  "outras op\\u00e7",
];
const CONSULTA_PATTERNS = [
  "consulta de ve",
  "consultar ve",
  "consulta.*ve\\u00edculo",
  "ve\\u00edculos?",
  "consultar",
];

function lerHeader(h: Record<string, string>, nome: string): string | undefined {
  const alvo = nome.toLowerCase();
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === alvo) return v;
  return undefined;
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
      // Um handler que lança NÃO pode derrubar o processo (ws 'message' relança).
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

  // Timeout em TODA chamada: se um diálogo nativo bloquear o renderizador, o
  // Runtime.evaluate nunca responderia e travaria o laço. Aqui rejeitamos.
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

  /** Avalia JS na página e devolve o valor por cópia (com await de Promise). */
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
    await new Promise((res) => setTimeout(res, 500));
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const soToken = args.includes("--so-token");
  const setupOnly = args.includes("--setup-cert");
  // Login MANUAL por padrão (como no RS): você conduz o gov.br na janela; o
  // solver só captura credenciais/sitekey e mina o captcha. --auto-login ativa
  // os cliques automáticos no portal (experimental).
  const autoLogin = args.includes("--auto-login");
  const placaIdx = args.indexOf("--placa");
  const placaFiltro = placaIdx >= 0 ? args[placaIdx + 1] : undefined;

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Setup do login por certificado A1 (import do .pfx + política do Chrome).
  // Roda ANTES de abrir o Chrome para a política valer já no arranque.
  if (setupOnly || autoLogin) {
    console.log("== Setup do certificado digital (A1) ==");
    runCertSetup();
    console.log("");
    if (setupOnly) {
      console.log("Setup concluído. Rode o solver sem --setup-cert para consultar.");
      return;
    }
  }

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
  // Sem estes handlers, um evento 'error' do ws (sem listener) derruba o Node
  // (EventEmitter relança). Tratamos para o solver sobreviver a quedas de socket.
  let wsFechado = false;
  ws.on("error", (e) => console.error(`[ws] erro: ${(e as Error)?.message ?? e}`));
  ws.on("close", () => {
    wsFechado = true;
  });
  const cdp = new Cdp(ws);

  // Fecha o Chrome de verdade (não só o socket de depuração) após capturar os
  // dados. `Browser.close` encerra o navegador pela conexão browser-level; se
  // falhar, ainda fechamos o WebSocket. Idempotente/best-effort.
  let navegadorFechado = false;
  async function fecharNavegador(): Promise<void> {
    if (navegadorFechado) return;
    navegadorFechado = true;
    try {
      await cdp.send("Browser.close", {}, undefined, 5000);
    } catch {
      /* best-effort: pode já estar fechando */
    }
    try {
      ws.close();
    } catch {
      /* já fechado */
    }
  }

  const cred: Cred = {};
  // Sitekey eventualmente capturado da rede (fallback; o default é a constante).
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
      // O alvo nasce PAUSADO (waitForDebuggerOnStart). Configuramos tudo —
      // crucialmente Debugger.setSkipAllPauses — ANTES de liberar, para que o
      // trap anti-debug (`debugger;` da Cloudflare/gov.br) nunca congele a aba.
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
          // Libera o alvo para começar a executar (sai do estado pausado).
          cdp.send("Runtime.runIfWaitingForDebugger", {}, sid).catch(() => {});
        }
      })();
    } else if (m.method === "Debugger.paused") {
      // Rede de segurança: se algo pausou mesmo assim, retoma na hora.
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
      // Sitekey do Turnstile aparece na URL do iframe da Cloudflare (0x...).
      if (!sitekeyNet && url.includes("challenges.cloudflare.com")) {
        const mm = url.match(/0x[0-9A-Za-z_-]{15,}/);
        if (mm) {
          // Apenas FALLBACK/diagnóstico — NÃO cacheamos: pode ser o sitekey do
          // desafio gerenciado da home, não o do widget de consulta. O bom vem
          // do hook (turnstile.render do portal) e é esse que cacheamos.
          sitekeyNet = mm[0];
          console.log(`  • sitekey visto na rede (fallback): ${sitekeyNet.slice(0, 10)}…`);
        }
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

  function sessaoPortal(): string | undefined {
    // Aba ativa durante o portal OU durante o login gov.br/acesso.gov.br.
    for (const [sid, s] of sessions) {
      if (s.type === "page" && /(detran\.sc\.gov\.br|acesso\.gov\.br)/.test(s.url)) {
        return sid;
      }
    }
    for (const [sid, s] of sessions) if (s.type === "page") return sid;
    return undefined;
  }

  function pageSessions(): string[] {
    const out: string[] = [];
    for (const [sid, s] of sessions) if (s.type === "page") out.push(sid);
    return out;
  }

  async function hostDe(sid: string): Promise<string> {
    try {
      return (await cdp.evaluate<string>("location.host", sid)) || "";
    } catch {
      return "";
    }
  }

  if (autoLogin) {
    console.log("Chrome aberto. Login AUTOMÁTICO (experimental) em andamento...");
  } else {
    console.log("Chrome aberto. Na janela: basta fazer o LOGIN gov.br (o certificado A1");
    console.log("é apresentado sozinho pela política) e deixar a janela aberta.");
    console.log("Não é preciso fazer consulta manual — o solver cuida do captcha.");
  }
  console.log("Aguardando login (JWT) (timeout 8 min)...\n");

  // 2) Espera credenciais + sitekey, dirigindo o login gov.br quando autoLogin.
  // Itera TODAS as abas (o gov.br pode abrir em outra aba/janela) e loga o host
  // de cada uma para diagnóstico.
  const TIMEOUT_MIN = 8;
  const deadline = Date.now() + TIMEOUT_MIN * 60 * 1000;
  let sid: string | undefined;
  let sitekey: string | null = null;
  let ultimoClique = "";
  let proximoHeartbeat = Date.now() + 30_000;
  const hostsVistos = new Set<string>();
  while (Date.now() < deadline) {
    if (!(await chromeVivo())) {
      console.error("Janela do Chrome fechada antes de capturar credenciais. Abortado.");
      process.exit(1);
    }
    if (wsFechado) {
      console.error(
        "[ws] socket de depuração fechado — não consigo mais dirigir o browser. Reinicie o solver.",
      );
      break;
    }

    if (Date.now() >= proximoHeartbeat) {
      proximoHeartbeat = Date.now() + 30_000;
      const restante = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      console.log(
        `  … aguardando login gov.br (login=${cred.auth ? "ok" : "-"}, ${restante}s restantes)`,
      );
    }

    for (const ps of pageSessions()) {
      // reinjeta o hook (caso a SPA tenha navegado/recarregado)
      await cdp.evaluate(DETRAN_BROWSER_HOOK, ps).catch(() => {});

      const host = await hostDe(ps);
      if (host && !hostsVistos.has(host)) {
        hostsVistos.add(host);
        console.log(`  • aba em: ${host}`);
      }

      // Só dirigimos cliques no PORTAL do DETRAN (iniciar gov.br / abrir
      // consulta). NUNCA clicamos na modal do gov.br (acesso.gov.br) — isso a
      // travava; o login lá é conduzido por você (com o cert auto-selecionado).
      const noDetran = /detran\.sc\.gov\.br/.test(host);
      if (autoLogin && noDetran) {
        const padroes = [...LOGIN_PATTERNS, ...CONSULTA_PATTERNS];
        const clicado = await cdp
          .evaluate<string | null>(
            `window.__lanzaClick ? window.__lanzaClick(${JSON.stringify(padroes)}) : null`,
            ps,
          )
          .catch(() => null);
        if (clicado && clicado !== ultimoClique) {
          ultimoClique = clicado;
          console.log(`  → cliquei: "${clicado}" (${host || "?"})`);
        }
      }

      // Basta uma aba do DETRAN (origem correta) — o mint CARREGA o Turnstile
      // sozinho (injeta o api.js) e usa o sitekey + action conhecidos. Não é
      // preciso o utilizador abrir/fazer consulta manual.
      if (noDetran) {
        const env = process.env.DETRAN_SC_TURNSTILE_SITEKEY?.trim();
        sitekey = env || sitekeyNet || DETRAN_SC_SITEKEY;
        sid = ps;
      }

      // Fallback: se a rede ainda não trouxe o JWT, tenta achá-lo no storage.
      if (!cred.auth) {
        const tok = await cdp
          .evaluate<string | null>(
            "window.__lanzaScanToken ? window.__lanzaScanToken() : null",
            ps,
          )
          .catch(() => null);
        if (tok) {
          cred.auth = `Bearer ${tok}`;
          console.log(`  • JWT encontrado no storage (${host || "?"})`);
        }
      }
    }

    if (!sid) sid = sessaoPortal();
    if (cred.auth && sid && sitekey) break;
    await sleep(2500);
  }

  if (!cred.auth) {
    console.error("✗ Não capturei o token (Authorization). Faça uma consulta no portal e tente de novo.");
    process.exit(1);
  }
  if (!sid) {
    console.error("✗ Não encontrei a aba do portal DETRAN SC.");
    process.exit(1);
  }
  if (!sitekey) {
    console.error(
      "✗ Não descobri o sitekey do Turnstile. Abra a tela de consulta de veículo (que mostra o captcha) e rode de novo, ou defina DETRAN_SC_TURNSTILE_SITEKEY.",
    );
    process.exit(1);
  }
  console.log(
    `✓ Login OK (token ${cred.auth.length}c, empresa=${cred.empresa ?? "?"}) | sitekey=${sitekey.slice(0, 10)}…\n`,
  );

  // Modo "só token": mina um e sai (para usar com sync-infracoes --captcha).
  if (soToken) {
    const token = await cdp.evaluate<string>(
      `window.__lanzaMint(${JSON.stringify(sitekey)}, ${JSON.stringify(DETRAN_SC_ACTION)})`,
      sid,
    );
    console.log(`TOKEN_OK len=${token.length}`);
    console.log("Use: npx tsx src/run.ts sync-infracoes --captcha \"<TOKEN>\" --placa <PLACA>");
    console.log("(token de uso único e validade curta — gere e use imediatamente)");
    // Não imprime o token inteiro em logs; grava em arquivo temp do SO.
    const f = path.join(os.tmpdir(), "detran_turnstile_token.txt");
    fs.writeFileSync(f, token, "utf8");
    console.log(`Token salvo em: ${f}`);
    await fecharNavegador();
    return;
  }

  // 3) Loop da frota.
  const veiculos = loadVeiculosParaSync(placaFiltro);
  console.log(
    `Frota SC ativa: ${veiculos.length} veículo(s)${placaFiltro ? ` (filtro ${placaFiltro})` : ""}${dryRun ? " | DRY-RUN" : ""}\n`,
  );

  let ok = 0;
  let falhas = 0;
  for (let i = 0; i < veiculos.length; i++) {
    const v = veiculos[i]!;
    const renavam = String(v.renavam).replace(/\D/g, "");
    const placaApi = compactPlaca(v.placa);
    try {
      const token = await cdp.evaluate<string>(
        `window.__lanzaMint(${JSON.stringify(sitekey)}, ${JSON.stringify(DETRAN_SC_ACTION)})`,
        sid,
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
        sid,
      );

      if (DEBUG) console.error(`[debug] ${v.placa} →`, JSON.stringify(res).slice(0, 300));

      if (!res || res.status !== "ok" || !res.payload) {
        falhas++;
        console.log(`✗ ${v.placa} | ${res?.message ?? "sem payload"}`);
        await sleep(1500);
        continue;
      }

      const payload = res.payload;
      fs.writeFileSync(
        path.join(OUT_DIR, `${placaApi}.json`),
        JSON.stringify(payload, null, 2),
        "utf8",
      );

      const inf = processarRespostaDetranSc(v.placa, payload, { dryRun, prazoDias: 90 });
      const desp = processarDespesasDetranSc(v.placa, payload, { dryRun });
      ok++;
      console.log(
        `✓ ${v.placa} | INFRAÇÕES novos:${inf.novos} atu:${inf.atualizados} hist:${inf.historico}` +
          (inf.revisarManual ? ` revisar:${inf.revisarManual}` : "") +
          ` | IPVA/LIC novos:${desp.novos} atu:${desp.atualizados} ign:${desp.ignorados}`,
      );
      for (const a of inf.avisos) console.log(`    inf: ${a}`);
      for (const a of desp.avisos) console.log(`    desp: ${a}`);
    } catch (e) {
      falhas++;
      console.log(`✗ ${v.placa} | erro: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (i < veiculos.length - 1) await sleep(1500);
  }

  console.log(`\nConcluído: ${ok} OK, ${falhas} falha(s). Payloads em ${OUT_DIR}`);
  await fecharNavegador();
  console.log("Navegador fechado.");
}

// Não deixar o processo morrer em silêncio por um erro assíncrono solto
// (ex.: evento do ws). Logamos e seguimos vivos; o laço cuida do fluxo.
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
