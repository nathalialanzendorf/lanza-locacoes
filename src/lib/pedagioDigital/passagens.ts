/**
 * Passagens de pedágio (em aberto / pagas) por placa no pedagiodigital.com.
 */
import { compactPlaca } from "../placa.js";
import { PEDAGIO_DIGITAL_ORIGIN } from "./auth.js";
import { bffFetchJson, pickArray } from "./client.js";

// Endpoint confirmado (27/06/2026): uma chamada lista as passagens de TODAS as
// placas informadas em `placas` (compactas, separadas por vírgula).
const LIST_LOGADO_PATH = "/Passagem/list-logado";

export type PassagemStatus = "aberto" | "pago" | "todos";

export type PassagemPedagio = {
  /** Identificador único da passagem no portal (chave natural do débito). */
  id: string;
  placa: string;
  /** Data/hora da passagem em ISO 8601, quando interpretável. */
  dataHoraIso: string | null;
  /** Data/hora original como veio do portal. */
  dataHoraRaw: string;
  valor: number;
  praca: string | null;
  rodovia: string | null;
  /** true = em aberto / não paga. */
  emAberto: boolean;
  raw: Record<string, unknown>;
};

function pickStr(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
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
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** Aceita ISO ou "DD/MM/AAAA[ HH:mm[:ss]]" e devolve ISO + flag de validade. */
export function parsePassagemData(s: string): string | null {
  const t = String(s || "").trim();
  if (!t) return null;
  const br = t.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (br) {
    const [, dd, mm, yyyy, hh = "00", mi = "00", ss = "00"] = br;
    const d = new Date(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}-03:00`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function inferEmAberto(o: Record<string, unknown>): boolean {
  const txt = pickStr(o, ["status", "situacao", "dsStatus", "statusPagamento", "stPagamento"]).toLowerCase();
  if (/pago|quitad|liquidad|baixad/.test(txt)) return false;
  // pedagiodigital: "Pendente" e "Confirmado" são débitos a cobrar (em aberto);
  // só "Pago/Quitado" sai como liquidado.
  if (/aberto|pendente|confirmad|devedor|nao\s*pago|não\s*pago|atrasad/.test(txt)) return true;
  // Sem texto de status: tenta flags booleanas comuns.
  for (const k of ["pago", "blPago", "isPago", "quitado"]) {
    if (typeof o[k] === "boolean") return !(o[k] as boolean);
  }
  return true;
}

function normalizarPassagem(item: unknown): PassagemPedagio | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;

  const placa = pickStr(o, ["placa", "nrPlaca", "nuPlaca", "dsPlaca", "placaVeiculo", "plate"]);
  const id =
    pickStr(o, [
      "id",
      "idPassagem",
      "idTransacao",
      "nrTransacao",
      "codigo",
      "protocolo",
      "uuid",
    ]) || "";

  const dataHoraRaw = pickStr(o, [
    "dataHora",
    "dataHoraPassagem",
    "dtPassagem",
    "data",
    "dtTransacao",
    "dataTransacao",
  ]);

  const valor = parseValor(
    o.valor ?? o.vlPassagem ?? o.vlPedagio ?? o.valorPedagio ?? o.total ?? o.vlTotal,
  );

  const praca = pickStr(o, ["praca", "pracaPedagio", "dsPraca", "nomePraca", "local", "concessionaria"]) || null;
  const rodovia = pickStr(o, ["rodovia", "dsRodovia", "via", "trecho", "concessao"]) || null;

  const dataHoraIso = parsePassagemData(dataHoraRaw);

  // Sem id estável, compõe chave determinística (placa + data normalizada + valor),
  // imune a variações de formato da data entre execuções → idempotente.
  const key =
    id ||
    [
      compactPlaca(placa),
      (dataHoraIso ?? dataHoraRaw).replace(/\D/g, ""),
      Math.round(valor * 100),
    ]
      .filter(Boolean)
      .join("-");
  if (!key) return null;

  return {
    id: key,
    placa,
    dataHoraIso,
    dataHoraRaw,
    valor,
    praca,
    rodovia,
    emAberto: inferEmAberto(o),
    raw: o,
  };
}

/** Extrai e normaliza passagens de um payload já obtido (offline/debug). */
export function extrairPassagens(raw: unknown): PassagemPedagio[] {
  // `itens` é a chave usada por /Passagem/list-logado (confirmado 28/06/2026).
  const arr = pickArray(raw, ["itens", "passagens", "transacoes", "extrato", "items", "data"]);
  return arr
    .map(normalizarPassagem)
    .filter((p): p is PassagemPedagio => p !== null);
}

/**
 * Consulta as passagens de várias placas numa única chamada
 * (`GET /Passagem/list-logado?placas=P1,P2,...`). Cada passagem traz a sua placa.
 */
export async function listarPassagensLote(
  placas: string[],
  opts: { status?: PassagemStatus } = {},
): Promise<PassagemPedagio[]> {
  const compactas = [...new Set(placas.map(compactPlaca).filter(Boolean))];
  if (compactas.length === 0) return [];
  const raw = await bffFetchJson(LIST_LOGADO_PATH, {
    query: { placas: compactas.join(",") },
    referer: `${PEDAGIO_DIGITAL_ORIGIN}/home.html?auth=1`,
  });
  return filtrarStatus(extrairPassagens(raw), opts.status ?? "todos");
}

/** Consulta passagens de uma placa (atalho sobre o lote, filtrando a placa pedida). */
export async function listarPassagens(
  placa: string,
  opts: { status?: PassagemStatus } = {},
): Promise<PassagemPedagio[]> {
  const alvo = compactPlaca(placa);
  const todas = await listarPassagensLote([placa], opts);
  return todas.filter((p) => compactPlaca(p.placa) === alvo);
}

export function filtrarStatus(
  passagens: PassagemPedagio[],
  status: PassagemStatus,
): PassagemPedagio[] {
  if (status === "aberto") return passagens.filter((p) => p.emAberto);
  if (status === "pago") return passagens.filter((p) => !p.emAberto);
  return passagens;
}
