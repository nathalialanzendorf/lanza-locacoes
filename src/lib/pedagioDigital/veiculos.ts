/**
 * Veículos (placas) no pedagiodigital.com: cadastrar e listar.
 */
import { compactPlaca, formatPlacaHyphen } from "../placa.js";
import { PEDAGIO_DIGITAL_ORIGIN } from "./auth.js";
import { bffFetchJson, bffFetchRaw, PedagioAuthError, pickArray } from "./client.js";

const REGISTER_PATH = "/Placa/register";
const DELETE_PATH = "/Placa/delete";

// GET /Placa/list (confirmado). Mantém fallbacks por robustez.
const VEICULOS_PATHS = ["/Placa/list", "/Placa", "/Placa/listar", "/Veiculo"] as const;

export type RegistrarPlacaInput = {
  placa: string;
  /** Modelo do veículo enviado no campo `modelo` do BFF (ex.: "GOL 1.0"). */
  modelo: string;
  /** Marca/fabricante (ex.: "VOLKSWAGEN"). */
  marca?: string;
  /** Ano (modelo) do veículo (ex.: 2013). */
  ano?: number | string;
  /** Cor do veículo (ex.: "PRATA"). */
  cor?: string;
  cdStatus?: boolean;
  blPlacaInternacional?: boolean;
};

export type VeiculoPedagio = {
  placa: string;
  modelo: string | null;
  /** Id da placa na conta (`idUsuarioPlaca`) — necessário para excluir. */
  id: string | null;
  raw: Record<string, unknown>;
};

/** Marca a partir de `marcaModelo` do veiculos.json ("VW/GOL 1.0" -> "VW"). */
export function marcaDeMarcaModelo(marcaModelo: string | undefined | null): string {
  const s = String(marcaModelo ?? "").trim();
  if (!s) return "";
  const antesDaBarra = s.split("/")[0]!.trim();
  return (antesDaBarra || s).toUpperCase();
}

/** Cadastra uma placa no pedagiodigital.com (usado após cadastro-veiculo). */
export async function registrarPlaca(input: RegistrarPlacaInput): Promise<{
  ok: boolean;
  status: number;
  placa: string;
  body: string;
}> {
  const placa = compactPlaca(input.placa);
  const payload: Record<string, unknown> = {
    placa,
    modelo: input.modelo,
    cdStatus: input.cdStatus ?? true,
    blPlacaInternacional: input.blPlacaInternacional ?? false,
  };
  // Campos extra (marca/ano/cor) — só enviados quando disponíveis.
  if (input.marca?.toString().trim()) payload.marca = input.marca.toString().trim();
  const anoStr = input.ano != null ? String(input.ano).trim() : "";
  if (anoStr) payload.ano = anoStr;
  if (input.cor?.toString().trim()) payload.cor = input.cor.toString().trim();

  const r = await bffFetchRaw(REGISTER_PATH, {
    method: "POST",
    referer: `${PEDAGIO_DIGITAL_ORIGIN}/add-veiculo`,
    body: payload,
  });
  const body = await r.text();
  return { ok: r.ok, status: r.status, placa: formatPlacaHyphen(placa), body };
}

function pickStr(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return null;
}

function normalizarVeiculo(item: unknown): VeiculoPedagio | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const placa = pickStr(o, ["placa", "nrPlaca", "plate", "placaVeiculo"]);
  if (!placa) return null;
  return {
    placa: formatPlacaHyphen(placa),
    modelo: pickStr(o, ["modelo", "dsModelo", "marca", "model"]),
    id: pickStr(o, ["idUsuarioPlaca", "idPlaca", "id"]),
    raw: o,
  };
}

/** Exclui uma placa do pedagiodigital.com pelo seu `idUsuarioPlaca`. */
export async function excluirPlaca(idUsuarioPlaca: string | number): Promise<{
  ok: boolean;
  status: number;
  body: string;
}> {
  const r = await bffFetchRaw(`${DELETE_PATH}/${idUsuarioPlaca}`, {
    method: "POST",
    referer: `${PEDAGIO_DIGITAL_ORIGIN}/veiculos`,
  });
  const body = await r.text();
  return { ok: r.ok, status: r.status, body };
}

export type ExcluirPlacaResult = {
  ok: boolean;
  status: number;
  body: string;
  placa: string;
  id: string | null;
  /** true quando a placa não estava cadastrada no portal (nada a excluir). */
  naoEncontrada: boolean;
};

/** Resolve o `idUsuarioPlaca` pela placa (via lista) e exclui. */
export async function excluirPlacaPorPlaca(placa: string): Promise<ExcluirPlacaResult> {
  const alvo = compactPlaca(placa);
  const formatada = formatPlacaHyphen(placa);
  const lista = await listarVeiculos();
  const v = lista.find((x) => compactPlaca(x.placa) === alvo);
  if (!v || !v.id) {
    return { ok: true, status: 0, body: "", placa: formatada, id: v?.id ?? null, naoEncontrada: true };
  }
  const r = await excluirPlaca(v.id);
  return { ...r, placa: formatada, id: v.id, naoEncontrada: false };
}

/** Lista os veículos/placas cadastrados na conta. */
export async function listarVeiculos(): Promise<VeiculoPedagio[]> {
  let lastErr: unknown = null;
  for (const path of VEICULOS_PATHS) {
    try {
      const raw = await bffFetchJson(path);
      const arr = pickArray(raw, ["placas", "veiculos", "data", "items"]);
      const out = arr
        .map(normalizarVeiculo)
        .filter((v): v is VeiculoPedagio => v !== null);
      if (out.length || Array.isArray(raw) || arr.length === 0) return out;
    } catch (e) {
      if (e instanceof PedagioAuthError) throw e;
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  return [];
}
