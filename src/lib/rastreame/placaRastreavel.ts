import { formatPlacaHyphen } from "../placa.js";

/** Extrai placa do texto `value` do rastreável Rastreame (ex.: "BBV-6A91 - BBV6A91 - GOL"). */
export function extrairPlacaDeRastreavel(value: string): string | null {
  const t = String(value ?? "").trim();
  if (!t) return null;
  const m = t.match(/\b([A-Za-z]{3}[-\s]?\d[A-Za-z0-9]\d{2})\b/);
  if (!m) return null;
  return formatPlacaHyphen(m[1]!);
}

export function refKey(ref: { key?: string | number; id?: string | number } | undefined): string {
  return String(ref?.key ?? ref?.id ?? "");
}
