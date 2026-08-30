/// <reference path="./ambient.d.ts" />
/** Handler HTTP da API — sem listen (Vercel carrega via api/index.mjs). */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  getDbBackend,
  runSchemaMigration,
  resetJsonDocumentAdapterCache,
} from "@lanza/db";
import { apiHost, apiPort } from "./config.js";
import { json } from "./http.js";
import { obterStatusLite } from "./services/statusLite.js";

async function bootstrapPostgres(): Promise<void> {
  if (!process.env.VERCEL || getDbBackend() === "file") return;
  if (process.env.LANZA_RUN_MIGRATION !== "1") return;
  try {
    await runSchemaMigration(false);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[lanza] bootstrap Postgres (Vercel):", msg);
  }
}

function warmupOcrLocal(): void {
  void import("../../../src/lib/documentoOcr.js")
    .then((m) => m.warmupOcrWorker())
    .catch((err) => {
      console.warn("[lanza] OCR warmup ignorado:", err instanceof Error ? err.message : err);
    });
}

let appServer: Server | null = null;
let appLoadError: string | null = null;
let appLoading: Promise<Server> | null = null;
let bootstrapped = false;

async function loadAppServer(): Promise<Server> {
  if (appServer) return appServer;
  if (appLoadError) {
    return createServer((_req, res) => {
      json(res, 500, {
        error: "API não iniciou",
        detail: appLoadError,
        hint: "Ver logs Vercel (FUNCTION_INVOCATION_FAILED)",
      });
    });
  }
  if (!appLoading) {
    appLoading = import("./app.js")
      .then(({ createApp, logStartup }) => {
        try {
          appServer = createApp();
          if (!process.env.VERCEL) {
            logStartup(apiPort(), apiHost());
          }
          return appServer;
        } catch (err) {
          appLoadError = err instanceof Error ? err.message : String(err);
          console.error("[lanza] createApp falhou:", err);
          appServer = createServer((_req, res) => {
            json(res, 500, {
              error: "API não iniciou",
              detail: appLoadError,
              hint: "Ver logs Vercel (FUNCTION_INVOCATION_FAILED)",
            });
          });
          return appServer;
        }
      })
      .catch((err) => {
        appLoadError = err instanceof Error ? err.message : String(err);
        console.error("[lanza] import app falhou:", err);
        appServer = createServer((_req, res) => {
          json(res, 500, {
            error: "API não iniciou",
            detail: appLoadError,
            hint: "Ver logs Vercel (FUNCTION_INVOCATION_FAILED)",
          });
        });
        return appServer;
      });
  }
  return appLoading;
}

function pathnameOf(req: IncomingMessage): string {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    return url.pathname.replace(/\/+$/, "") || "/";
  } catch {
    return "/";
  }
}

function isFastHealth(req: IncomingMessage): boolean {
  if (req.method !== "GET") return false;
  const p = pathnameOf(req);
  return p === "/health" || p === "/health/";
}

async function handleHealthFull(res: ServerResponse): Promise<void> {
  const { obterStatusSistema } = await import("./services/status.js");
  json(res, 200, await obterStatusSistema());
}

function runBootstrapOnce(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  void bootstrapPostgres();
  warmupOcrLocal();
}

let gateway: Server | null = null;

export function getGatewayServer(): Server {
  if (gateway) return gateway;
  gateway = createServer((req, res) => {
    runBootstrapOnce();
    if (isFastHealth(req)) {
      const full = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).searchParams.get(
        "full",
      );
      if (full === "1") {
        void handleHealthFull(res).catch((err) => {
          console.error("[lanza] /health?full=1:", err);
          if (!res.headersSent) json(res, 500, { error: "health check falhou" });
        });
        return;
      }
      json(res, 200, obterStatusLite());
      return;
    }

    void loadAppServer()
      .then((app) => {
        app.emit("request", req, res);
      })
      .catch((err) => {
        console.error("[lanza] request:", err);
        if (!res.headersSent) json(res, 500, { error: "Erro interno do servidor" });
      });
  });
  return gateway;
}

/** Entrada para api/index.mjs na Vercel (sem second listen). */
export function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  if (process.env.VERCEL) resetJsonDocumentAdapterCache();
  getGatewayServer().emit("request", req, res);
}

export default handleRequest;
