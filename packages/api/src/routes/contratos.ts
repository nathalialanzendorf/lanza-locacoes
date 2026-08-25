import {
  badRequest,
  compileRoute,
  contentDispositionAttachment,
  handleServiceError,
  HttpError,
  json,
  notFound,
  readBodyBuffer,
  readJsonBody,
  routeAsync,
  type RouteDef,
} from "../http.js";
import * as contratosService from "../services/contratos.js";
import * as contratosWrite from "../services/contratosWrite.js";
import type { ContratoCriarRenovarInput } from "../services/contratosWrite.js";
import * as contratosImportService from "../services/importacoes/contratos.js";
import type { MotivoEncerramento } from "../lib-imports.js";

const STATUS_VALIDOS = new Set(["ativo", "encerrado"]);

export function registerContratosRoutes(routes: RouteDef[]): void {
  const list = compileRoute("/api/contratos");
  routes.push({
    method: "GET",
    pattern: list.regex,
    paramNames: list.paramNames,
    handler: routeAsync(async (ctx) => {
      const statusRaw = ctx.query.get("status");
      if (statusRaw != null && statusRaw !== "" && !STATUS_VALIDOS.has(statusRaw)) {
        return badRequest(ctx, 'Query "status" inválida — use ativo ou encerrado');
      }
      json(ctx.res, 200, await contratosService.listarContratosAsync({
        status: statusRaw as "ativo" | "encerrado" | undefined,
        clienteId: ctx.query.get("clienteId") ?? undefined,
        veiculoId: ctx.query.get("veiculoId") ?? undefined,
        placa: ctx.query.get("placa") ?? undefined,
        dataInicial: ctx.query.get("dataInicial") ?? undefined,
        dataFinal: ctx.query.get("dataFinal") ?? undefined,
      }));
    }),
  });

  const criar = compileRoute("/api/contratos/criar");
  routes.push({
    method: "POST",
    pattern: criar.regex,
    paramNames: criar.paramNames,
    handler: routeAsync(async (ctx) => {
      const body = await readJsonBody<ContratoCriarRenovarInput>(ctx.req);
      const data = await contratosWrite.criarContrato(body);
      json(ctx.res, 201, { data });
    }),
  });

  const renovar = compileRoute("/api/contratos/renovar");
  routes.push({
    method: "POST",
    pattern: renovar.regex,
    paramNames: renovar.paramNames,
    handler: routeAsync(async (ctx) => {
      const body = await readJsonBody<ContratoCriarRenovarInput>(ctx.req);
      const data = await contratosWrite.renovarContrato(body);
      json(ctx.res, 201, { data });
    }),
  });

  const encerrar = compileRoute("/api/contratos/encerrar");
  routes.push({
    method: "POST",
    pattern: encerrar.regex,
    paramNames: encerrar.paramNames,
    handler: routeAsync(async (ctx) => {
      const body = await readJsonBody<{
        idOuPasta?: string;
        id?: string;
        dataEncerramento?: string;
        motivoEncerramento?: MotivoEncerramento;
        quebraContrato?: boolean;
      }>(ctx.req);
      const idOuPasta = body.idOuPasta ?? body.id;
      if (!idOuPasta || !body.dataEncerramento || !body.motivoEncerramento) {
        return badRequest(
          ctx,
          'Campos "idOuPasta", "dataEncerramento" e "motivoEncerramento" são obrigatórios',
        );
      }
      const data = await contratosWrite.encerrarContrato({
        idOuPasta,
        dataEncerramento: body.dataEncerramento,
        motivoEncerramento: body.motivoEncerramento,
        quebraContrato: body.quebraContrato,
      });
      json(ctx.res, 200, { data });
    }),
  });

  const contratoAssinado = compileRoute("/api/contratos/:id/contrato-assinado");
  routes.push({
    method: "GET",
    pattern: contratoAssinado.regex,
    paramNames: contratoAssinado.paramNames,
    handler: routeAsync(async (ctx) => {
      try {
        const file = await contratosWrite.downloadContratoAssinado(ctx.params.id);
        ctx.res.statusCode = 200;
        ctx.res.setHeader("Content-Type", file.contentType);
        ctx.res.setHeader("Content-Disposition", contentDispositionAttachment(file.filename));
        ctx.res.end(file.buffer);
      } catch (err) {
        handleServiceError(ctx, err);
      }
    }),
  });

  routes.push({
    method: "PUT",
    pattern: contratoAssinado.regex,
    paramNames: contratoAssinado.paramNames,
    handler: routeAsync(async (ctx) => {
      const filename =
        ctx.query.get("filename")?.trim() ||
        String(ctx.req.headers["x-filename"] ?? "").trim() ||
        "contrato-assinado.pdf";
      const contentType =
        String(ctx.req.headers["content-type"] ?? "").trim() || "application/pdf";
      const buffer = await readBodyBuffer(ctx.req);
      if (!buffer.length) {
        throw new HttpError(400, "Corpo do arquivo vazio");
      }
      const data = await contratosWrite.uploadContratoAssinado(ctx.params.id, buffer, {
        nomeArquivo: filename,
        contentType,
      });
      json(ctx.res, 200, { data });
    }),
  });

  const gerarDocumento = compileRoute("/api/contratos/:id/gerar-documento");
  routes.push({
    method: "POST",
    pattern: gerarDocumento.regex,
    paramNames: gerarDocumento.paramNames,
    handler: routeAsync(async (ctx) => {
      try {
        const gerado = await contratosWrite.gerarDocumentoContrato(ctx.params.id);
        const download = ctx.query.get("download")?.trim().toLowerCase();
        if (download === "docx" || download === "pdf") {
          const file = await contratosWrite.downloadDocumentoGeradoContrato(
            ctx.params.id,
            download,
          );
          ctx.res.statusCode = 200;
          ctx.res.setHeader("Content-Type", file.contentType);
          ctx.res.setHeader("Content-Disposition", contentDispositionAttachment(file.filename));
          ctx.res.end(file.buffer);
          return;
        }
        json(ctx.res, 200, { data: gerado });
      } catch (err) {
        handleServiceError(ctx, err);
      }
    }),
  });

  const documentoGerado = compileRoute("/api/contratos/:id/documento-gerado");
  routes.push({
    method: "GET",
    pattern: documentoGerado.regex,
    paramNames: documentoGerado.paramNames,
    handler: routeAsync(async (ctx) => {
      try {
        const formatoRaw = ctx.query.get("formato")?.trim().toLowerCase();
        if (formatoRaw !== "docx" && formatoRaw !== "pdf") {
          return badRequest(ctx, 'Query "formato" inválida — use docx ou pdf');
        }
        const file = await contratosWrite.downloadDocumentoGeradoContrato(
          ctx.params.id,
          formatoRaw,
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

  const sincronizar = compileRoute("/api/contratos/sincronizar");
  routes.push({
    method: "POST",
    pattern: sincronizar.regex,
    paramNames: sincronizar.paramNames,
    handler: routeAsync(async (ctx) => {
      try {
        const body = await readJsonBody<{ raiz?: string; dryRun?: boolean }>(ctx.req).catch(() => ({}));
        const data = await contratosImportService.executarImportacaoContratos(body);
        json(ctx.res, 200, { data });
      } catch (err) {
        handleServiceError(ctx, err);
      }
    }),
  });

  const one = compileRoute("/api/contratos/:id");
  routes.push({
    method: "GET",
    pattern: one.regex,
    paramNames: one.paramNames,
    handler: routeAsync(async (ctx) => {
      const item = await contratosService.obterContratoAsync(ctx.params.id);
      if (!item) return notFound(ctx, "Contrato");
      json(ctx.res, 200, { data: item });
    }),
  });

  routes.push({
    method: "PATCH",
    pattern: one.regex,
    paramNames: one.paramNames,
    handler: routeAsync(async (ctx) => {
      try {
        const body = await readJsonBody<contratosWrite.ContratoAtualizarInput>(ctx.req);
        const data = await contratosWrite.atualizarContrato(ctx.params.id, body);
        json(ctx.res, 200, { data });
      } catch (err) {
        handleServiceError(ctx, err);
      }
    }),
  });

  routes.push({
    method: "DELETE",
    pattern: one.regex,
    paramNames: one.paramNames,
    handler: routeAsync(async (ctx) => {
      try {
        const data = await contratosWrite.removerContrato(ctx.params.id);
        json(ctx.res, 200, { data });
      } catch (err) {
        handleServiceError(ctx, err);
      }
    }),
  });
}
