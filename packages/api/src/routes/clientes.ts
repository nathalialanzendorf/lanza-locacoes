import type { ClienteImportado, ClientePatch } from "../lib-imports.js";
import {
  badRequest,
  compileRoute,
  contentDispositionAttachment,
  handleServiceError,
  HttpError,
  json,
  notFound,
  parseAtivoQuery,
  readBodyBuffer,
  readJsonBody,
  routeAsync,
  type RouteDef,
} from "../http.js";
import * as clientesService from "../services/clientes.js";
import * as clienteDocumentos from "../services/clienteDocumentos.js";

type AtualizarClienteBody = ClientePatch;

export function registerClientesRoutes(routes: RouteDef[]): void {
  const list = compileRoute("/api/clientes");
  routes.push({
    method: "GET",
    pattern: list.regex,
    paramNames: list.paramNames,
    handler: routeAsync(async (ctx) => {
      const ativo = parseAtivoQuery(ctx.query.get("ativo"));
      if (ctx.query.has("ativo") && ativo === undefined) {
        badRequest(ctx, 'Query "ativo" inválida — use true ou false');
        return;
      }
      json(ctx.res, 200, await clientesService.listarClientesAsync({
        ativo,
        cpf: ctx.query.get("cpf") ?? undefined,
        nome: ctx.query.get("nome") ?? undefined,
        clienteQuery: ctx.query.get("q") ?? ctx.query.get("clienteQuery") ?? undefined,
      }));
    }),
  });

  routes.push({
    method: "POST",
    pattern: list.regex,
    paramNames: list.paramNames,
    handler: routeAsync(async (ctx) => {
      const body = await readJsonBody<ClienteImportado>(ctx.req);
      const r = await clientesService.criarCliente(body);
      json(ctx.res, 201, r);
    }),
  });

  const one = compileRoute("/api/clientes/:id");
  routes.push({
    method: "GET",
    pattern: one.regex,
    paramNames: one.paramNames,
    handler: routeAsync(async (ctx) => {
      const item = await clientesService.obterClienteAsync(ctx.params.id);
      if (!item) return notFound(ctx, "Cliente");
      json(ctx.res, 200, { data: item });
    }),
  });

  routes.push({
    method: "PATCH",
    pattern: one.regex,
    paramNames: one.paramNames,
    handler: routeAsync(async (ctx) => {
      const patch = await readJsonBody<AtualizarClienteBody>(ctx.req);
      const data = await clientesService.atualizarClienteAsync(ctx.params.id, patch);
      json(ctx.res, 200, { data });
    }),
  });

  routes.push({
    method: "DELETE",
    pattern: one.regex,
    paramNames: one.paramNames,
    handler: routeAsync(async (ctx) => {
      try {
        const data = await clientesService.removerClienteAsync(ctx.params.id);
        json(ctx.res, 200, { data });
      } catch (err) {
        handleServiceError(ctx, err);
      }
    }),
  });

  const docUpload = compileRoute("/api/clientes/:id/documentos/:tipo");
  routes.push({
    method: "PUT",
    pattern: docUpload.regex,
    paramNames: docUpload.paramNames,
    handler: routeAsync(async (ctx) => {
      const filename =
        ctx.query.get("filename")?.trim() ||
        String(ctx.req.headers["x-filename"] ?? "").trim() ||
        "documento.pdf";
      const contentType = String(ctx.req.headers["content-type"] ?? "").trim() || undefined;
      const buffer = await readBodyBuffer(ctx.req);
      if (!buffer.length) throw new HttpError(400, "Corpo do arquivo vazio");
      try {
        const data = await clienteDocumentos.uploadClienteDocumento(
          ctx.params.id,
          ctx.params.tipo,
          buffer,
          { nomeArquivo: filename, contentType },
        );
        json(ctx.res, 200, { data });
      } catch (err) {
        handleServiceError(ctx, err);
      }
    }),
  });

  routes.push({
    method: "GET",
    pattern: docUpload.regex,
    paramNames: docUpload.paramNames,
    handler: routeAsync(async (ctx) => {
      try {
        const file = await clienteDocumentos.downloadClienteDocumento(
          ctx.params.id,
          ctx.params.tipo,
        );
        ctx.res.statusCode = 200;
        ctx.res.setHeader("Content-Type", file.contentType);
        ctx.res.setHeader("Content-Disposition", contentDispositionAttachment(file.filename));
        ctx.res.end(file.buffer);
      } catch (err) {
        handleServiceError(ctx, err);
      }
    }),
  });
}
