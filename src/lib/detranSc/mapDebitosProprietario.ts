import type { DetranScConsultaVeiculo, DetranScDebito } from "./types.js";
import { isDebitoMulta } from "./mapInfracoes.js";

function pickStr(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}

function parseValor(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v * 100) / 100;
  const s = String(v ?? "")
    .replace(/R\$\s*/i, "")
    .trim();
  if (!s) return 0;
  const n = s.includes(",")
    ? parseFloat(s.replace(/\./g, "").replace(",", "."))
    : parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function textoDebito(d: DetranScDebito): string {
  const o = d as Record<string, unknown>;
  return [d.classe, d.descricao, d.tipo, o.nome, o.descricaoClasse]
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

export function isDebitoIpva(d: DetranScDebito): boolean {
  if (isDebitoMulta(d)) return false;
  return /\bipva\b/.test(textoDebito(d));
}

export function isDebitoLicenciamento(d: DetranScDebito): boolean {
  if (isDebitoMulta(d)) return false;
  const t = textoDebito(d);
  return /licenciamento/.test(t) && !/\bipva\b/.test(t);
}

function parseExercicio(d: DetranScDebito): string {
  const ex = pickStr(d as Record<string, unknown>, ["exercicio", "anoExercicio"]);
  if (ex) return ex.replace(/\D/g, "").slice(0, 4) || ex;
  const classe = String(d.classe ?? (d as Record<string, unknown>).descricaoClasse ?? "");
  const m = classe.match(/(20\d{2})/);
  return m?.[1] ?? "";
}

/** Converte data ISO (YYYY-MM-DD) para o formato local DD/MM/AAAA. */
function paraDataBr(s: string): string {
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return s;
}

function parseVencimento(d: DetranScDebito): string {
  const v = pickStr(d as Record<string, unknown>, [
    "vencimento",
    "dataVencimento",
    "dataVencimentoOriginal",
    "data",
  ]);
  return v ? paraDataBr(v) : "";
}

export type DetranDespesaNormalizada = {
  categoria: "IPVA" | "Licenciamento";
  descricao: string;
  data: string;
  valor: number;
  competencia: string;
  origem: string;
  exercicio: string;
};

function normalizarDebitoDespesa(
  placa: string,
  d: DetranScDebito,
  categoria: "IPVA" | "Licenciamento",
): DetranDespesaNormalizada | null {
  const o = d as Record<string, unknown>;
  const valor = parseValor(o.valorAtualizado ?? d.valorAtual ?? d.valor);
  if (valor <= 0) return null;

  const exercicio = parseExercicio(d);
  const data = parseVencimento(d);
  if (!data) return null;

  const placaKey = placa.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const numeroNet = pickStr(o, ["numeroDetranNET", "idDebito", "numero"]);
  const origemSuffix = numeroNet || exercicio || data.replace(/\D/g, "");
  const origem = `detran-sc/debitos/${placaKey}/${categoria}/${origemSuffix}`;

  const descricaoBase =
    pickStr(o, ["descricaoClasse", "classe", "descricao", "tipo"]) || categoria;
  const descricao =
    exercicio && !descricaoBase.includes(exercicio)
      ? `${descricaoBase} (${exercicio})`
      : descricaoBase;

  const competenciaMatch = data.match(/^\d{2}\/(\d{2})\/(\d{4})/);
  const competencia = competenciaMatch
    ? `${competenciaMatch[1]}/${competenciaMatch[2]}`
    : exercicio
      ? `12/${exercicio}`
      : "";

  return {
    categoria,
    descricao,
    data,
    valor,
    competencia,
    origem,
    exercicio,
  };
}

function unwrapPayload(raw: unknown): DetranScConsultaVeiculo {
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  const nested = [o.data, o.veiculo, o.resultado, o.payload, o.content].find(
    (x) => x && typeof x === "object",
  ) as DetranScConsultaVeiculo | undefined;
  if (nested?.debitos) return nested;
  return o as DetranScConsultaVeiculo;
}

/** Extrai IPVA e Licenciamento de `debitos` (despesas do parceiro/dono). */
export function extrairDespesasDetranSc(
  placa: string,
  raw: unknown,
): {
  despesas: DetranDespesaNormalizada[];
  ignorados: number;
} {
  const payload = unwrapPayload(raw);
  const despesas: DetranDespesaNormalizada[] = [];
  const seen = new Set<string>();
  let ignorados = 0;

  for (const d of payload.debitos ?? []) {
    let cat: "IPVA" | "Licenciamento" | null = null;
    if (isDebitoIpva(d)) cat = "IPVA";
    else if (isDebitoLicenciamento(d)) cat = "Licenciamento";
    else {
      ignorados++;
      continue;
    }

    const norm = normalizarDebitoDespesa(placa, d, cat);
    if (!norm || seen.has(norm.origem)) continue;
    seen.add(norm.origem);
    despesas.push(norm);
  }

  return { despesas, ignorados };
}
