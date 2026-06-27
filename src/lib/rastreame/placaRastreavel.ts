import { formatPlacaHyphen } from "../placa.js";

/** Extrai placa do texto `value` do rastreável Rastreame (ex.: "BBV-6A91 - BBV6A91 - GOL"). */
export function extrairPlacaDeRastreavel(value: string): string | null {
  const t = String(value ?? "").trim();
  if (!t) return null;
  const m = t.match(/\b([A-Za-z]{3}[-\s]?\d[A-Za-z0-9]\d{2})\b/);
  if (!m) return null;
  return formatPlacaHyphen(m[1]!);
}

/**
 * Texto descritivo do rastreável, compatível com os dois formatos da API:
 *   - referência embutida em gastos: campo `value` ("PLACA - COMPACT - MODELO (dono)")
 *   - listagem/detalhe de rastreável: campos `identificador` (placa) + `descricao`
 */
export function rastreavelTexto(
  r: { value?: string; identificador?: string; descricao?: string } | undefined,
): string {
  const value = String(r?.value ?? "").trim();
  if (value) return value;
  const ident = String(r?.identificador ?? "").trim();
  const desc = String(r?.descricao ?? "").trim();
  if (ident && desc) return `${ident} - ${desc}`;
  return ident || desc || "";
}

export function refKey(ref: { key?: string | number; id?: string | number } | undefined): string {
  return String(ref?.key ?? ref?.id ?? "");
}
