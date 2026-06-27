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
};

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
    db.veiculos.push(registro);
    saveVeiculosDb(db);
    return { registro, acao: "novo", aviso: "cadastro mínimo — completar CRLV/FIPE" };
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

  const changed =
    !placasIguais(v.placa, placa) ||
    (input.marcaModelo && v.marcaModelo !== input.marcaModelo) ||
    (input.anoModelo && v.anoModelo !== input.anoModelo) ||
    v.rastreameLabel !== (input.rastreameLabel ?? v.rastreameLabel) ||
    (input.ativo === false && v.ativo !== false) ||
    (input.ativo !== false && v.ativo === false);

  v.rastreameRastreavelKey = input.rastreameRastreavelKey;
  if (input.rastreameLabel) v.rastreameLabel = input.rastreameLabel;
  if (input.marcaModelo && (!v.marcaModelo || v.origem === "rastreame")) {
    v.marcaModelo = input.marcaModelo;
  }
  if (input.anoModelo && (!v.anoModelo || v.origem === "rastreame")) {
    v.anoModelo = input.anoModelo;
  }
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
  if (v.rastreameRastreavelKey != null && v.rastreameRastreavelKey !== "") return true;
  return isVeiculoAtivo(v) && Boolean(String(v.placa ?? "").trim());
}
