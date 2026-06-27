import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { normCpfKey, type ClienteImportado } from "./rastreame/mapMotoristaCliente.js";
import { REPO_ROOT } from "./repoRoot.js";

export const DB_CLIENTES = path.join(REPO_ROOT, "database", "clientes.json");

export type ClienteRegistro = ClienteImportado & {
  id: string;
  nome: string;
  cpf?: string;
  rastreameMotoristaKey?: string | number | null;
  rastreameMotoristaId?: string | number | null;
  rastreameSyncEm?: string | null;
  atualizadoEm?: string | null;
  ativo?: boolean;
  origemImportacao?: string;
};

type ClientesDb = {
  descricao?: string;
  atualizadoEm?: string;
  schemaCliente?: unknown;
  clientes: ClienteRegistro[];
};

const DEFAULT_DESCRICAO =
  "Clientes (motoristas/locatários) da frota. id = uuid. Chave natural: cpf.";

function nowIso(): string {
  return new Date().toISOString();
}

export function loadClientesDb(): ClientesDb {
  if (!fs.existsSync(DB_CLIENTES)) {
    return { descricao: DEFAULT_DESCRICAO, clientes: [] };
  }
  return JSON.parse(fs.readFileSync(DB_CLIENTES, "utf8")) as ClientesDb;
}

export function saveClientesDb(db: ClientesDb): void {
  db.atualizadoEm = new Date().toISOString().slice(0, 10);
  if (!db.descricao) db.descricao = DEFAULT_DESCRICAO;
  fs.writeFileSync(DB_CLIENTES, JSON.stringify(db, null, 2), "utf8");
}

export function isClienteAtivo(c: ClienteRegistro): boolean {
  return c.ativo !== false;
}

export function findClienteById(id: string): ClienteRegistro | null {
  return loadClientesDb().clientes.find((c) => c.id === id) ?? null;
}

export function findClienteByCpf(cpf: string): ClienteRegistro | null {
  const key = normCpfKey(cpf);
  if (!key) return null;
  return (
    loadClientesDb().clientes.find((c) => c.cpf && normCpfKey(String(c.cpf)) === key) ?? null
  );
}

export function findClienteByRastreameKey(key: string | number): ClienteRegistro | null {
  const k = String(key);
  return (
    loadClientesDb().clientes.find(
      (c) => c.rastreameMotoristaKey != null && String(c.rastreameMotoristaKey) === k,
    ) ?? null
  );
}

function cnhKey(c: ClienteRegistro): string {
  const cnh = c.cnh as Record<string, string> | undefined;
  return String(cnh?.numeroRegistro ?? "").replace(/\D/g, "");
}

export function findClienteIndex(
  c: Pick<ClienteRegistro, "id" | "cpf" | "rastreameMotoristaKey"> & { cnh?: unknown },
): number {
  const db = loadClientesDb();
  if (c.rastreameMotoristaKey != null && c.rastreameMotoristaKey !== "") {
    const rk = String(c.rastreameMotoristaKey);
    const idx = db.clientes.findIndex(
      (x) => x.rastreameMotoristaKey != null && String(x.rastreameMotoristaKey) === rk,
    );
    if (idx >= 0) return idx;
  }
  if (c.cpf) {
    const cpfK = normCpfKey(String(c.cpf));
    const idx = db.clientes.findIndex((x) => x.cpf && normCpfKey(String(x.cpf)) === cpfK);
    if (idx >= 0) return idx;
  }
  const ck = cnhKey(c as ClienteRegistro);
  if (ck) {
    return db.clientes.findIndex((x) => cnhKey(x) === ck);
  }
  if (c.id) return db.clientes.findIndex((x) => x.id === c.id);
  return -1;
}

export type ClientePatch = Partial<
  Pick<
    ClienteRegistro,
    | "nome"
    | "cpf"
    | "rg"
    | "rgOrgaoExpedidor"
    | "dataNascimento"
    | "localNascimento"
    | "filiacao"
    | "telefone"
    | "email"
    | "endereco"
    | "cnh"
    | "rastreameMotoristaKey"
    | "rastreameMotoristaId"
    | "ativo"
    | "origemImportacao"
  >
>;

export function editarCliente(idOrCpf: string, patch: ClientePatch): ClienteRegistro | null {
  const db = loadClientesDb();
  const key = idOrCpf.trim();
  let idx = db.clientes.findIndex((c) => c.id === key);
  if (idx < 0) {
    const byCpf = findClienteByCpf(key);
    if (byCpf) idx = db.clientes.findIndex((c) => c.id === byCpf.id);
  }
  if (idx < 0) return null;

  const c = db.clientes[idx]!;
  Object.assign(c, patch);
  c.atualizadoEm = nowIso();
  db.clientes[idx] = c;
  saveClientesDb(db);
  return c;
}

export function excluirCliente(idOrCpf: string): ClienteRegistro | null {
  return editarCliente(idOrCpf, { ativo: false });
}

export type UpsertMotoristaInput = ClienteImportado & {
  rastreameMotoristaKey: string | number;
  rastreameMotoristaId?: string | number;
  ativo?: boolean;
  force?: boolean;
};

export type UpsertClienteResult = {
  registro: ClienteRegistro;
  acao: "novo" | "atualizado" | "sem_alteracao";
  aviso: string | null;
};

export function upsertClienteFromRastreame(input: UpsertMotoristaInput): UpsertClienteResult {
  const db = loadClientesDb();
  const ts = nowIso();
  const idx = findClienteIndex({
    id: input.id ?? "",
    cpf: input.cpf,
    rastreameMotoristaKey: input.rastreameMotoristaKey,
    cnh: input.cnh,
  });

  if (idx < 0) {
    const registro: ClienteRegistro = {
      ...input,
      id: crypto.randomUUID(),
      nome: String(input.nome ?? "").trim(),
      rastreameMotoristaKey: input.rastreameMotoristaKey,
      rastreameMotoristaId: input.rastreameMotoristaId ?? null,
      rastreameSyncEm: ts,
      ativo: input.ativo !== false,
      origemImportacao: input.origemImportacao ?? "rastreame",
      atualizadoEm: ts,
    };
    db.clientes.push(registro);
    saveClientesDb(db);
    return { registro, acao: "novo", aviso: null };
  }

  const existente = db.clientes[idx]!;
  if (
    !input.force &&
    existente.atualizadoEm &&
    existente.rastreameSyncEm &&
    existente.atualizadoEm > existente.rastreameSyncEm
  ) {
    return {
      registro: existente,
      acao: "sem_alteracao",
      aviso: "local mais recente — pull ignorado",
    };
  }

  const merged: ClienteRegistro = {
    ...existente,
    ...input,
    id: existente.id,
    rastreameMotoristaKey: input.rastreameMotoristaKey,
    rastreameMotoristaId: input.rastreameMotoristaId ?? existente.rastreameMotoristaId ?? null,
    rastreameSyncEm: ts,
    ativo: input.ativo !== false,
  };

  if (input.nome && (!existente.nome || existente.origemImportacao === "rastreame")) {
    merged.nome = String(input.nome).trim();
  }
  if (input.cpf && !existente.cpf) merged.cpf = input.cpf;
  if (input.cnh && typeof input.cnh === "object") {
    merged.cnh = { ...(existente.cnh as object), ...(input.cnh as object) };
  }
  if (input.endereco && typeof input.endereco === "object") {
    merged.endereco = { ...(existente.endereco as object), ...(input.endereco as object) };
  }

  const changed = JSON.stringify(existente) !== JSON.stringify(merged);
  db.clientes[idx] = merged;
  saveClientesDb(db);
  return { registro: merged, acao: changed ? "atualizado" : "sem_alteracao", aviso: null };
}

export function gravarCliente(
  cliente: ClienteImportado,
  opts?: { syncRastreame?: boolean },
): UpsertClienteResult {
  const db = loadClientesDb();
  const ts = nowIso();
  const idx = findClienteIndex({
    id: cliente.id ?? "",
    cpf: cliente.cpf,
    rastreameMotoristaKey: cliente.rastreameMotoristaKey,
    cnh: cliente.cnh,
  });

  if (idx >= 0) {
    const existente = db.clientes[idx]!;
    const merged: ClienteRegistro = {
      ...existente,
      ...cliente,
      id: existente.id,
      atualizadoEm: ts,
      ativo: cliente.ativo !== false ? true : false,
    };
    db.clientes[idx] = merged;
    saveClientesDb(db);
    return { registro: merged, acao: "atualizado", aviso: null };
  }

  const registro: ClienteRegistro = {
    ...cliente,
    id: crypto.randomUUID(),
    nome: String(cliente.nome ?? "").trim(),
    atualizadoEm: ts,
    ativo: cliente.ativo !== false,
  };
  db.clientes.push(registro);
  saveClientesDb(db);
  void opts?.syncRastreame;
  return { registro, acao: "novo", aviso: null };
}

export function marcarClienteRastreameSyncOk(
  idOrCpf: string,
  rastreameKey?: string | number,
  rastreameId?: string | number,
): ClienteRegistro | null {
  const db = loadClientesDb();
  const key = idOrCpf.trim();
  let idx = db.clientes.findIndex((c) => c.id === key);
  if (idx < 0) {
    const byCpf = findClienteByCpf(key);
    if (byCpf) idx = db.clientes.findIndex((c) => c.id === byCpf.id);
  }
  if (idx < 0) return null;
  const c = db.clientes[idx]!;
  if (rastreameKey != null) c.rastreameMotoristaKey = rastreameKey;
  if (rastreameId != null) c.rastreameMotoristaId = rastreameId;
  c.rastreameSyncEm = nowIso();
  db.clientes[idx] = c;
  saveClientesDb(db);
  return c;
}

/** Cliente elegível para espelhar no Rastreame (nome + CPF ou CNH). */
export function isSyncRastreameEligible(c: ClienteRegistro): boolean {
  if (c.rastreameMotoristaKey != null && c.rastreameMotoristaKey !== "") return true;
  const nome = String(c.nome ?? "").trim();
  if (!nome) return false;
  const cnh = cnhKey(c);
  const cpf = c.cpf ? normCpfKey(String(c.cpf)) : "";
  return Boolean(cpf || cnh);
}
