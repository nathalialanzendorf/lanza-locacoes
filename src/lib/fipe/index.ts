/**
 * Tool FIPE — consulta da Tabela FIPE (parallelum) reutilizável.
 *
 * - `client`: HTTP de baixo nível + tipos.
 * - `consulta`: marcas/modelos/anos/valor + URL pública.
 * - `resolverVeiculo`: resolução automática a partir dos dados do veículo.
 */
export * from "./client.js";
export * from "./consulta.js";
export * from "./resolverVeiculo.js";
