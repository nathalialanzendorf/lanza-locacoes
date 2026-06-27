import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { compactPlaca, formatPlacaHyphen, placasIguais } from "./placa.js";
import { REPO_ROOT } from "./repoRoot.js";

export const DB_VEICULOS = path.join(REPO_ROOT, "database", "veiculos.json");

export type VeiculoRegistro = {
  id: string;
  placa: string;
  marcaModelo?: string;
  anoModelo?: string;
  chassi?: string;
  renavam?: string;
  cor?: string;
  /** Campos do CRV-e espelhados do Rastreame (rastreável). */
  marca?: string;
  modelo?: string;
  ano?: number;
  combustivel?: string;
  categoria?: string;
  tipo?: string;
  licencaIma?: string;
  vencimentoDocumento?: string;
  fipe?: string;
  fipeModelo?: string;
  fipeCodigo?: string;
  fipeValor?: string;
  fipeReferencia?: string;
  /** key do rastreável em rastreame.com.br */
  rastreameRastreavelKey?: string | number | null;
  /** Texto exibido no Rastreame (campo value). */
  rastreameLabel?: string | null;
  rastreameSyncEm?: string | null;
  /** ISO 8601 — última alteração local */
  atualizadoEm?: string | null;
  /** false = excluído da frota ativa */
  ativo?: boolean;
  /**
   * true = veículo PARTICULAR do proprietário (ex.: carro da Ana), não é de
   * locação. Entra nos syncs DETRAN (infrações/IPVA/licenciamento) mas NÃO no
   * rastreador fixo nem no Rastreame (não é rastreável de locação).
   */
  particular?: boolean;
  origem?: string;
  [key: string]: unknown;
};

type VeiculosDb = {
  descricao?: string;
  atualizadoEm?: string;
  veiculos: VeiculoRegistro[];
};

const DEFAULT_DESCRICAO =
  "Frota de locação de veículos da Nathalia. id = uuid. Chave natural: placa.";

function nowIso(): string {
  return new Date().toISOString();
}

export function loadVeiculosDb(): VeiculosDb {
  if (!fs.existsSync(DB_VEICULOS)) {
    return { descricao: DEFAULT_DESCRICAO, veiculos: [] };
  }
  return JSON.parse(fs.readFileSync(DB_VEICULOS, "utf8")) as VeiculosDb;
}

export function saveVeiculosDb(db: VeiculosDb): void {
  db.atualizadoEm = new Date().toISOString().slice(0, 10);
  if (!db.descricao) db.descricao = DEFAULT_DESCRICAO;
  fs.writeFileSync(DB_VEICULOS, JSON.stringify(db, null, 2), "utf8");
}

export function isVeiculoAtivo(v: VeiculoRegistro): boolean {
  return v.ativo !== false;
}

export function findVeiculoByPlaca(placa: string): VeiculoRegistro | null {
  const db = loadVeiculosDb();
  return db.veiculos.find((v) => placasIguais(v.placa, placa)) ?? null;
}

export function findVeiculoByRastreameKey(key: string | number): VeiculoRegistro | null {
  const k = String(key);
  const db = loadVeiculosDb();
  return (
    db.veiculos.find(
      (v) => v.rastreameRastreavelKey != null && String(v.rastreameRastreavelKey) === k,
    ) ?? null
  );
}

export function findVeiculoById(id: string): VeiculoRegistro | null {
  const db = loadVeiculosDb();
  return db.veiculos.find((v) => v.id === id) ?? null;
}

export type VeiculoPatch = Partial<
  Pick<
    VeiculoRegistro,
    | "marcaModelo"
    | "anoModelo"
    | "chassi"
    | "renavam"
    | "cor"
    | "fipe"
    | "fipeModelo"
    | "fipeCodigo"
    | "fipeValor"
    | "fipeReferencia"
    | "rastreameRastreavelKey"
    | "rastreameLabel"
    | "ativo"
    | "origem"
  >
>;

export function editarVeiculo(idOrPlaca: string, patch: VeiculoPatch): VeiculoRegistro | null {
  const db = loadVeiculosDb();
  const key = idOrPlaca.trim();
  const idx = db.veiculos.findIndex(
    (v) =>
      v.id === key ||
      placasIguais(v.placa, key) ||
      compactPlaca(v.placa) === compactPlaca(key),
  );
  if (idx < 0) return null;

  const v = db.veiculos[idx]!;
  Object.assign(v, patch);
  v.atualizadoEm = nowIso();
  db.veiculos[idx] = v;
  saveVeiculosDb(db);
  return v;
}

export function excluirVeiculo(idOrPlaca: string): VeiculoRegistro | null {
  return editarVeiculo(idOrPlaca, { ativo: false });
}

export type UpsertRastreavelInput = {
  rastreameRastreavelKey: string | number;
  placa: string;
  marcaModelo?: string;
  anoModelo?: string;
  rastreameLabel?: string;
  ativo?: boolean;
  force?: boolean;
  /** Campos do CRV-e vindos do detalhe do rastreável (fonte: Rastreame). */
  chassi?: string;
  renavam?: string;
  cor?: string;
  marca?: string;
  modelo?: string;
  ano?: number;
  combustivel?: string;
  categoria?: string;
  tipo?: string;
  licencaIma?: string;
  vencimentoDocumento?: string;
};

/** Campos factuais do CRV-e — Rastreame é a base, então sobrescrevem o local. */
const CRV_FIELDS = [
  "chassi",
  "renavam",
  "cor",
  "marca",
  "modelo",
  "ano",
  "combustivel",
  "categoria",
  "tipo",
  "licencaIma",
  "vencimentoDocumento",
] as const;

function aplicarCamposCrv(v: VeiculoRegistro, input: UpsertRastreavelInput): boolean {
  let changed = false;
  for (const f of CRV_FIELDS) {
    const novo = input[f];
    if (novo == null || novo === "") continue;
    if (v[f] !== novo) {
      v[f] = novo;
      changed = true;
    }
  }
  return changed;
}

export type UpsertVeiculoResult = {
  registro: VeiculoRegistro;
  acao: "novo" | "atualizado" | "sem_alteracao";
  aviso: string | null;
};

export function upsertVeiculoFromRastreame(input: UpsertRastreavelInput): UpsertVeiculoResult {
  const db = loadVeiculosDb();
  const placa = formatPlacaHyphen(input.placa);
  const rk = String(input.rastreameRastreavelKey);
  const ts = nowIso();

  let idx = db.veiculos.findIndex(
    (v) => v.rastreameRastreavelKey != null && String(v.rastreameRastreavelKey) === rk,
  );
  if (idx < 0) {
    idx = db.veiculos.findIndex((v) => placasIguais(v.placa, placa));
  }

  if (idx < 0) {
    const registro: VeiculoRegistro = {
      id: crypto.randomUUID(),
      placa,
      marcaModelo: input.marcaModelo,
      anoModelo: input.anoModelo,
      rastreameRastreavelKey: input.rastreameRastreavelKey,
      rastreameLabel: input.rastreameLabel ?? null,
      rastreameSyncEm: ts,
      ativo: input.ativo !== false,
      origem: "rastreame",
      atualizadoEm: ts,
    };
    aplicarCamposCrv(registro, input);
    db.veiculos.push(registro);
    saveVeiculosDb(db);
    return { registro, acao: "novo", aviso: "cadastro a partir do Rastreame (CRV-e)" };
  }

  const v = db.veiculos[idx]!;
  if (
    !input.force &&
    v.atualizadoEm &&
    v.rastreameSyncEm &&
    v.atualizadoEm > v.rastreameSyncEm
  ) {
    return { registro: v, acao: "sem_alteracao", aviso: "local mais recente — pull ignorado" };
  }

  const crvChanged = aplicarCamposCrv(v, input);

  const changed =
    crvChanged ||
    !placasIguais(v.placa, placa) ||
    (input.marcaModelo && !v.marcaModelo) ||
    (input.anoModelo && !v.anoModelo) ||
    v.rastreameLabel !== (input.rastreameLabel ?? v.rastreameLabel) ||
    (input.ativo === false && v.ativo !== false) ||
    (input.ativo !== false && v.ativo === false);

  v.rastreameRastreavelKey = input.rastreameRastreavelKey;
  if (input.rastreameLabel) v.rastreameLabel = input.rastreameLabel;
  // marcaModelo/anoModelo são compostos (usados em contrato/FIPE): preencher só se faltar.
  if (input.marcaModelo && !v.marcaModelo) v.marcaModelo = input.marcaModelo;
  if (input.anoModelo && !v.anoModelo) v.anoModelo = input.anoModelo;
  if (input.ativo === false) v.ativo = false;
  else if (input.ativo !== false && v.ativo === false && input.force) v.ativo = true;
  else if (input.ativo !== false) v.ativo = true;
  v.rastreameSyncEm = ts;
  if (!v.origem) v.origem = "rastreame";

  db.veiculos[idx] = v;
  saveVeiculosDb(db);
  return {
    registro: v,
    acao: changed ? "atualizado" : "sem_alteracao",
    aviso: null,
  };
}

export type FipeFields = Pick<
  VeiculoRegistro,
  "fipe" | "fipeModelo" | "fipeCodigo" | "fipeValor" | "fipeReferencia"
>;

/** Veículo sem dados FIPE (precisa de resolução). */
export function precisaFipe(v: VeiculoRegistro): boolean {
  return !String(v.fipeCodigo ?? "").trim() || !String(v.fipeValor ?? "").trim();
}

/**
 * Grava os campos FIPE de um veículo. Enriquecimento local (não vai ao
 * Rastreame): `atualizadoEm` e `rastreameSyncEm` ficam iguais para não acionar
 * o guard "local mais recente" no próximo pull.
 */
export function aplicarFipeVeiculo(id: string, fipe: FipeFields): VeiculoRegistro | null {
  const db = loadVeiculosDb();
  const idx = db.veiculos.findIndex((v) => v.id === id);
  if (idx < 0) return null;
  const v = db.veiculos[idx]!;
  for (const [k, val] of Object.entries(fipe)) {
    if (val != null) (v as Record<string, unknown>)[k] = val;
  }
  const ts = nowIso();
  v.atualizadoEm = ts;
  v.rastreameSyncEm = ts;
  db.veiculos[idx] = v;
  saveVeiculosDb(db);
  return v;
}

export function marcarVeiculoRastreameSyncOk(
  idOrPlaca: string,
  rastreameKey?: string | number,
  label?: string,
): VeiculoRegistro | null {
  const db = loadVeiculosDb();
  const key = idOrPlaca.trim();
  const idx = db.veiculos.findIndex(
    (v) =>
      v.id === key ||
      placasIguais(v.placa, key) ||
      compactPlaca(v.placa) === compactPlaca(key),
  );
  if (idx < 0) return null;
  const v = db.veiculos[idx]!;
  if (rastreameKey != null) v.rastreameRastreavelKey = rastreameKey;
  if (label) v.rastreameLabel = label;
  v.rastreameSyncEm = nowIso();
  db.veiculos[idx] = v;
  saveVeiculosDb(db);
  return v;
}

/** Veículo espelhado ou elegível para o Rastreame. */
export function isSyncRastreameEligible(v: VeiculoRegistro): boolean {
  // Particular (não-locação) nunca vira rastreável novo no Rastreame.
  if (v.particular === true && (v.rastreameRastreavelKey == null || v.rastreameRastreavelKey === "")) {
    return false;
  }
  if (v.rastreameRastreavelKey != null && v.rastreameRastreavelKey !== "") return true;
  return isVeiculoAtivo(v) && Boolean(String(v.placa ?? "").trim());
}
