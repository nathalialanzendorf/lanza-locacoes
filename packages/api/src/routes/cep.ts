import {
  badRequest,
  compileRoute,
  handleServiceError,
  json,
  routeAsync,
  type RouteDef,
} from "../http.js";
import * as cepService from "../services/cep.js";

export function registerCepRoutes(routes: RouteDef[]): void {
  const one = compileRoute("/api/cep/:cep");
  routes.push({
    method: "GET",
    pattern: one.regex,
    paramNames: one.paramNames,
    handler: routeAsync(async (ctx) => {
      const cep = ctx.params.cep?.trim() ?? "";
      if (!cepService.cepValido(cep)) {
        badRequest(ctx, "CEP inválido — informe 8 dígitos");
        return;
      }
      try {
        const data = await cepService.consultarCep(cep);
        json(ctx.res, 200, { data });
      } catch (err) {
        handleServiceError(ctx, err);
      }
    }),
  });
}
