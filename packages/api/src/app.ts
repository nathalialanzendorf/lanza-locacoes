import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { API_VERSION, apiKey, authRequired, jwtSecret, resolveCorsOrigin } from "./config.js";
import { getDbBackend } from "@lanza/db";
import { json, matchRoute, type RouteDef } from "./http.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerAnaliseCadastroRoutes } from "./routes/analise-cadastro.js";
import { registerClienteAnaliseRoutes } from "./routes/cliente-analise.js";
import { registerCepRoutes } from "./routes/cep.js";
import { registerClientesRoutes } from "./routes/clientes.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerCronRoutes } from "./routes/cron.js";
import { registerContratosRoutes } from "./routes/contratos.js";
import { registerDespesasRoutes } from "./routes/despesas.js";
import { registerDocumentosRoutes } from "./routes/documentos.js";
import { registerFipeRoutes } from "./routes/fipe.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerInicioLocacoesRoutes } from "./routes/inicio-locacoes.js";
import { registerInfracoesRoutes } from "./routes/infracoes.js";
import { registerImportacoesRoutes } from "./routes/importacoes.js";
import { registerLocacoesRoutes } from "./routes/locacoes.js";
import { OPENAPI_PUBLIC_PATHS } from "./openapi/index.js";
import { registerMetaRoutes } from "./routes/meta.js";
import { registerOpenApiRoutes } from "./routes/openapi.js";
import { registerPagbankRoutes } from "./routes/pagbank.js";
import { registerParceiroDespesasRoutes } from "./routes/parceiro-despesas.js";
import { registerParceirosRoutes } from "./routes/parceiros.js";
import { registerPedagioRoutes } from "./routes/pedagio.js";
import { registerPortaisRoutes } from "./routes/portais.js";
import { registerEstacionamentoRoutes } from "./routes/estacionamento.js";
import { registerRenegociacaoRoutes } from "./routes/renegociacao.js";
import { registerRastreameRoutes } from "./routes/rastreame.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";
import { registerRecebimentosRoutes } from "./routes/recebimentos.js";
import { registerRelatoriosRoutes } from "./routes/relatorios.js";
import { registerSyncRoutes } from "./routes/sync.js";
import { registerVendasRoutes } from "./routes/vendas.js";
import { registerVeiculosRoutes } from "./routes/veiculos.js";
import { verifyAccessToken, extractBearerToken } from "./services/auth.js";

/** Rotas públicas de autenticação (sem JWT nem API key). */
export const AUTH_PUBLIC_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/status",
]);

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = resolveCorsOrigin(req.headers.origin);
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    if (origin !== "*") res.setHeader("Vary", "Origin");
  }
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-API-Key, Authorization, X-Filename",
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
}

async function isAuthorized(req: IncomingMessage, pathname: string): Promise<boolean> {
  if (AUTH_PUBLIC_PATHS.has(pathname)) return true;

  const token = extractBearerToken(req);
  if (token && jwtSecret()) {
    const payload = await verifyAccessToken(token);
    if (payload) return true;
  }

  const expected = apiKey();
  if (expected) {
    const provided = String(req.headers["x-api-key"] ?? "").trim();
    if (provided === expected) return true;
  }

  return !authRequired();
}

function collectRoutes(): RouteDef[] {
  const routes: RouteDef[] = [];
  registerHealthRoutes(routes);
  registerCronRoutes(routes);
  registerOpenApiRoutes(routes);
  registerAuthRoutes(routes);
  registerAdminRoutes(routes);
  registerMetaRoutes(routes);
  registerConfigRoutes(routes);
  registerClientesRoutes(routes);
  registerCepRoutes(routes);
  registerVeiculosRoutes(routes);
  registerVendasRoutes(routes);
  registerInicioLocacoesRoutes(routes);
  registerContratosRoutes(routes);
  registerDespesasRoutes(routes);
  registerLocacoesRoutes(routes);
  registerDashboardRoutes(routes);
  registerRecebimentosRoutes(routes);
  registerRelatoriosRoutes(routes);
  registerDocumentosRoutes(routes);
  registerSyncRoutes(routes);
  registerImportacoesRoutes(routes);
  registerAnaliseCadastroRoutes(routes);
  registerClienteAnaliseRoutes(routes);
  registerFipeRoutes(routes);
  registerParceirosRoutes(routes);
  registerParceiroDespesasRoutes(routes);
  registerInfracoesRoutes(routes);
  registerRenegociacaoRoutes(routes);
  registerRastreameRoutes(routes);
  registerPagbankRoutes(routes);
  registerPedagioRoutes(routes);
  registerPortaisRoutes(routes);
  registerEstacionamentoRoutes(routes);
  return routes;
}

export function createApp() {
  const routes = collectRoutes();

  return createServer(async (req, res) => {
    applyCors(req, res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname.replace(/\/+$/, "") || "/";
      const method = req.method ?? "GET";

      if (
        pathname.startsWith("/api") &&
        !OPENAPI_PUBLIC_PATHS.has(pathname) &&
        !(await isAuthorized(req, pathname))
      ) {
        json(res, 401, { error: "Não autorizado" });
        return;
      }

      const matched = matchRoute(routes, method, pathname);
      if (!matched) {
        json(res, 404, { error: "Rota não encontrada" });
        return;
      }

      await matched.handler({
        req,
        res,
        params: matched.params,
        query: url.searchParams,
        method,
        path: pathname,
      });
    } catch (err) {
      console.error("[@lanza/api] erro:", err);
      if (!res.headersSent) {
        json(res, 500, { error: "Erro interno do servidor" });
      }
    }
  });
}

export function logStartup(port: number, host: string): void {
  const parts: string[] = [];
  if (jwtSecret()) parts.push("LANZA_JWT_SECRET ativa");
  if (apiKey()) parts.push("LANZA_API_KEY ativa");
  const auth = parts.length ? parts.join(" · ") : "sem autenticação (modo dev)";
  const db = getDbBackend();
  console.log(`[@lanza/api] v${API_VERSION} em http://${host}:${port}`);
  console.log(`[@lanza/api] ${auth}`);
  console.log(`[@lanza/api] database: LANZA_DB_BACKEND=${db}`);
  console.log(
    `[@lanza/api] docs: http://${host}:${port}/api/docs | spec: /api/openapi.json`,
  );
}
