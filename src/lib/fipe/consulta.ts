/**
 * Consultas FIPE de alto nível (reutilizável por skills/CLIs):
 * marcas, modelos, anos, valor e construção da URL pública.
 */
import {
  fipeGet,
  type FipeAno,
  type FipeMarca,
  type FipeModelo,
  type FipeValor,
} from "./client.js";

const _MES: Record<string, number> = {
  janeiro: 1,
  fevereiro: 2,
  março: 3,
  marco: 3,
  abril: 4,
  maio: 5,
  junho: 6,
  julho: 7,
  agosto: 8,
  setembro: 9,
  outubro: 10,
  novembro: 11,
  dezembro: 12,
};

/** "junho de 2026" → "6-2026" (formato usado na URL pública FIPE). */
export function refParaMesano(ref: string): string {
  const m = String(ref || "")
    .toLowerCase()
    .match(/([a-zçãéíóúâ]+)\s+de\s+(\d{4})/);
  if (!m) return "";
  const mo = _MES[m[1]!] ?? 0;
  return mo ? `${mo}-${m[2]}` : "";
}

/** Normaliza a marca para o slug usado na URL pública (ex.: VW → vw-volkswagen). */
export function slugMarca(nome: string): string {
  const n = String(nome || "")
    .trim()
    .toLowerCase();
  if (["vw", "volkswagen", "vw-volkswagen"].includes(n)) return "vw-volkswagen";
  return n.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Monta a URL pública de veiculos.fipe.org.br a partir do detalhe de valor. */
export function montarUrlFipe(
  d: Pick<FipeValor, "brand" | "codeFipe" | "modelYear" | "referenceMonth">,
  fallbackBrand = "",
): string {
  const marcaSlug = slugMarca(d.brand || fallbackBrand);
  const mesano = refParaMesano(d.referenceMonth || "");
  return `https://veiculos.fipe.org.br?carro/${marcaSlug}/${mesano}/${d.codeFipe}/${d.modelYear}`;
}

export function listarMarcas(): Promise<FipeMarca[]> {
  return fipeGet<FipeMarca[]>("/brands");
}

export function listarModelos(marcaCode: string): Promise<FipeModelo[]> {
  return fipeGet<FipeModelo[]>(`/brands/${marcaCode}/models`);
}

export function listarAnos(
  marcaCode: string,
  modeloCode: string,
): Promise<FipeAno[]> {
  return fipeGet<FipeAno[]>(`/brands/${marcaCode}/models/${modeloCode}/years`);
}

export function consultarValor(
  marcaCode: string,
  modeloCode: string,
  anoCode: string,
): Promise<FipeValor> {
  return fipeGet<FipeValor>(
    `/brands/${marcaCode}/models/${modeloCode}/years/${anoCode}`,
  );
}
