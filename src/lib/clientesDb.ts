 
 
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { registroEstaAtivo } from "./domain/index.js";

import {
  jsonDocumentExists,
  loadJsonDocument,
  loadJsonDocumentForApi,
  saveJsonDocument,
  saveJsonDocumentAsync,
  useRelationalStore,
  assertRelationalStore,
  loadClientesFromSql,
  queryClientesFromSql,
  saveClientesToSql,
  upsertClienteToSql,
} from "@lanza/db";
import { isEntityUuid } from "./filtroListagem.js";
import { clientesScopeFromFilter } from "./scopedCatalogo.js";

import { normCpfKey, type ClienteImportado } from "./rastreame/mapMotoristaCliente.js";
import { REPO_ROOT } from "./repoRoot.js";
import {
  ultimaTriagemPorCpf,
  ultimaTriagemPorCpfAsync,
  type TriagemRegistro,
} from "./analiseCadastro/triagemDb.js";

export const DB_CLIENTES = path.join(REPO_ROOT, "database", "clientes.json");

/**
 * Resultado da análise de cadastro (antecedentes/processos) espelhado no cliente.
 * O detalhe completo fica em database/analise-cadastro.json + relatorios/analise-cadastro/.
 */
export type AnaliseCadastroCliente = {
  /** Passou na análise? true | false | null (pendente de decisão do operador). */
  aprovado: boolean | null;
  /** Quando a análise foi realizada (AAAA-MM-DD). */
  dataConsulta: string;
  /** Sinal automático das fontes (true = houve alerta). */
  alertaGeral: boolean;
  /** Conclusão automática (texto). */
  resumo: string;
  /** id do registro em database/analise-cadastro.json. */
  analiseId: string | null;
  /** Caminho do documento legível (.txt). */
  relatorioTxt: string | null;
  /** Quando este espelho foi gravado no cliente (ISO 8601). */
  avaliadoEm: string;
};

export type RastreameVinculoCliente = {
  veiculoId: string;
  placa?: string;
  rastreavelKey: string | number;
  vinculadoEm: string;
};

export type ClienteRegistro = ClienteImportado & {
  id: string;
  nome: string;
  cpf?: string;
  rastreameMotoristaKey?: string | number | null;
  rastreameMotoristaId?: string | number | null;
  /** Vínculos motorista↔rastreável espelhados do Rastreame (contrato ativo). */
  rastreameVinculos?: RastreameVinculoCliente[];
  rastreameSyncEm?: string | null;
  atualizadoEm?: string | null;
  ativo?: boolean;
  origemImportacao?: string;
  analiseCadastro?: AnaliseCadastroCliente | null;
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

function isEmptyVal(v: unknown): boolean {
  if (v == null || v === "") return true;
  if (typeof v === "object" && !Array.isArray(v)) {
    return Object.values(v as Record<string, unknown>).every(isEmptyVal);
  }
  return false;
}

/**
 * Mescla `extra` em `base` sem destruir valores locais já preenchidos:
 * só preenche lacunas (campos locais vazios) e recursa em objetos (cnh, endereco).
 */
function fillGaps(
  base: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v == null || v === "") continue;
    const cur = out[k];
    if (cur == null || cur === "") {
      out[k] = v;
    } else if (
      typeof cur === "object" &&
      !Array.isArray(cur) &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      out[k] = fillGaps(cur as Record<string, unknown>, v as Record<string, unknown>);
    }
  }
  return out;
}

export function loadClientesDb(): ClientesDb {
  if (!jsonDocumentExists(DB_CLIENTES)) {
    return { descricao: DEFAULT_DESCRICAO, clientes: [] };
  }
  return loadJsonDocument<ClientesDb>(DB_CLIENTES);
}

export type ClientesLoadScope = {
  ids?: string[];
  idOuCpf?: string;
  cpf?: string;
  nome?: string;
  clienteQuery?: string;
  q?: string;
  ativo?: boolean;
};

export async function loadClientesDbAsync(scope?: ClientesLoadScope): Promise<ClientesDb> {
  if (await useRelationalStore()) {
    const sqlFilter = clientesScopeFromFilter(scope ?? {});
    if (sqlFilter) {
      const clientes = (await queryClientesFromSql(sqlFilter)) as ClienteRegistro[];
      return {
        descricao: DEFAULT_DESCRICAO,
        atualizadoEm: new Date().toISOString().slice(0, 10),
        clientes,
      };
    }
    return (await loadClientesFromSql()) as ClientesDb;
  }
  return loadJsonDocumentForApi<ClientesDb>(DB_CLIENTES, {
    descricao: DEFAULT_DESCRICAO,
    clientes: [],
  });
}

export function findClienteInDb(db: ClientesDb, idOuCpf: string): ClienteRegistro | null {
  const key = idOuCpf.trim();
  const byId = db.clientes.find((c) => c.id === key);
  if (byId) return byId;
  const cpfKey = normCpfKey(key);
  if (!cpfKey) return null;
  return (
    db.clientes.find((c) => c.cpf && normCpfKey(String(c.cpf)) === cpfKey) ?? null
  );
}

export function saveClientesDb(db: ClientesDb): void {
  db.atualizadoEm = new Date().toISOString().slice(0, 10);
  if (!db.descricao) db.descricao = DEFAULT_DESCRICAO;
  saveJsonDocument(DB_CLIENTES, db, { description: DEFAULT_DESCRICAO });
}

export async function saveClientesDbAsync(db: ClientesDb): Promise<void> {
  db.atualizadoEm = new Date().toISOString().slice(0, 10);
  if (!db.descricao) db.descricao = DEFAULT_DESCRICAO;
  await assertRelationalStore();
  await saveClientesToSql(db);
}

export function isClienteAtivo(c: ClienteRegistro): boolean {
  return registroEstaAtivo(c.ativo);
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

/** Nome normalizado para comparação: sem acentos, sem parênteses, maiúsculas. */
export function normNomeKey(nome: string | null | undefined): string {
  return String(nome ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^A-Za-z\s]/g, " ")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
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

function findClienteUpsertIndex(
  db: ClientesDb,
  c: Pick<ClienteRegistro, "id" | "cpf" | "rastreameMotoristaKey"> & { cnh?: unknown },
): number {
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

export function findClienteIndex(
  c: Pick<ClienteRegistro, "id" | "cpf" | "rastreameMotoristaKey"> & { cnh?: unknown },
): number {
  return findClienteUpsertIndex(loadClientesDb(), c);
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
    | "rastreameVinculos"
    | "ativo"
    | "origemImportacao"
    | "analiseCadastro"
    | "cnhStorageKey"
    | "cnhDocumentoNome"
    | "comprovanteStorageKey"
    | "comprovanteDocumentoNome"
  >
>;

function findClienteIndexInDb(db: ClientesDb, idOrCpf: string): number {
  const found = findClienteInDb(db, idOrCpf);
  if (!found) return -1;
  return db.clientes.findIndex((c) => c.id === found.id);
}

function applyEditarCliente(
  db: ClientesDb,
  idOrCpf: string,
  patch: ClientePatch,
): ClienteRegistro | null {
  const idx = findClienteIndexInDb(db, idOrCpf);
  if (idx < 0) return null;

  const c = db.clientes[idx]!;
  const { endereco, cnh, ...rest } = patch;
  if (endereco && typeof endereco === "object") {
    c.endereco = { ...(c.endereco as object), ...(endereco as object) };
  }
  if (cnh && typeof cnh === "object") {
    c.cnh = { ...(c.cnh as object), ...(cnh as object) };
  }
  Object.assign(c, rest);
  c.atualizadoEm = nowIso();
  db.clientes[idx] = c;
  return c;
}

export function editarCliente(idOrCpf: string, patch: ClientePatch): ClienteRegistro | null {
  const db = loadClientesDb();
  const c = applyEditarCliente(db, idOrCpf, patch);
  if (!c) return null;
  saveClientesDb(db);
  return c;
}

export async function editarClienteAsync(
  idOrCpf: string,
  patch: ClientePatch,
): Promise<ClienteRegistro | null> {
  const key = idOrCpf.trim();
  if (await useRelationalStore()) {
    const db = await loadClientesDbAsync({ idOuCpf: key });
    const c = applyEditarCliente(db, key, patch);
    if (!c) return null;
    await upsertClienteToSql(c as unknown as Record<string, unknown>);
    return c;
  }
  const db = loadClientesDb();
  const c = applyEditarCliente(db, key, patch);
  if (!c) return null;
  saveClientesDb(db);
  return c;
}

export function excluirCliente(idOrCpf: string): ClienteRegistro | null {
  return editarCliente(idOrCpf, { ativo: false });
}

export async function excluirClienteAsync(idOrCpf: string): Promise<ClienteRegistro | null> {
  return editarClienteAsync(idOrCpf, { ativo: false });
}

/** Monta o espelho de análise de cadastro do cliente a partir de um registro do histórico. */
export function analiseClienteDeRegistro(t: TriagemRegistro): AnaliseCadastroCliente {
  return {
    aprovado: t.aprovado ?? null,
    dataConsulta: t.dataConsulta,
    alertaGeral: t.alertaGeral,
    resumo: t.resumo,
    analiseId: t.id ?? null,
    relatorioTxt: t.relatorioTxt ?? t.relatorioJson ?? null,
    avaliadoEm: nowIso(),
  };
}

/**
 * Grava o resultado da análise de cadastro no cliente (por id ou CPF).
 * Idempotente — sempre reflete a última análise. Retorna null se não houver
 * cliente cadastrado para a chave (ex.: análise feita antes do cadastro).
 */
function applyRegistrarAnaliseCadastroNoCliente(
  db: ClientesDb,
  idOrCpf: string,
  dados: AnaliseCadastroCliente,
): ClienteRegistro | null {
  const key = idOrCpf.trim();
  const found = findClienteInDb(db, key);
  if (!found) return null;
  const idx = db.clientes.findIndex((c) => c.id === found.id);
  if (idx < 0) return null;
  const c = db.clientes[idx]!;
  c.analiseCadastro = dados;
  // Reprovado na análise (não passou) → inativa o cliente (local).
  if (dados.aprovado === false) c.ativo = false;
  c.atualizadoEm = nowIso();
  db.clientes[idx] = c;
  return c;
}

export function registrarAnaliseCadastroNoCliente(
  idOrCpf: string,
  dados: AnaliseCadastroCliente,
): ClienteRegistro | null {
  const db = loadClientesDb();
  const c = applyRegistrarAnaliseCadastroNoCliente(db, idOrCpf, dados);
  if (!c) return null;
  saveClientesDb(db);
  return c;
}

export async function registrarAnaliseCadastroNoClienteAsync(
  idOrCpf: string,
  dados: AnaliseCadastroCliente,
): Promise<ClienteRegistro | null> {
  const key = idOrCpf.trim();
  if (await useRelationalStore()) {
    const db = await loadClientesDbAsync({ idOuCpf: key });
    const c = applyRegistrarAnaliseCadastroNoCliente(db, key, dados);
    if (!c) return null;
    await upsertClienteToSql(c as unknown as Record<string, unknown>);
    return c;
  }
  return registrarAnaliseCadastroNoCliente(key, dados);
}

/**
 * Se o cliente ainda não tem `analiseCadastro` e existe uma análise no histórico
 * para o seu CPF, herda automaticamente (caso "analisar antes de cadastrar").
 * Síncrono — só para CLI/local. Na Vercel use {@link herdarAnaliseCadastroAsync}.
 */
function herdarAnaliseCadastro(c: ClienteRegistro): void {
  // Sync path com Postgres na Vercel deadlocks (awaitSync + event loop).
  if (process.env.VERCEL) return;
  if (c.analiseCadastro != null) return;
  if (!c.cpf) return;
  const ult = ultimaTriagemPorCpf(String(c.cpf));
  if (!ult) return;
  c.analiseCadastro = analiseClienteDeRegistro(ult);
  // Se a última análise reprovou (não passou), nasce/permanece inativo.
  if (c.analiseCadastro.aprovado === false) c.ativo = false;
}

/** Herança de análise via Postgres async — seguro na Vercel. */
async function herdarAnaliseCadastroAsync(c: ClienteRegistro): Promise<void> {
  if (c.analiseCadastro != null) return;
  if (!c.cpf) return;
  const ult = await ultimaTriagemPorCpfAsync(String(c.cpf));
  if (!ult) return;
  c.analiseCadastro = analiseClienteDeRegistro(ult);
  if (c.analiseCadastro.aprovado === false) c.ativo = false;
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

export function upsertClienteFromRastreame(rawInput: UpsertMotoristaInput): UpsertClienteResult {
  const db = loadClientesDb();
  const ts = nowIso();
  // `force` é uma flag de controlo — não deve ser persistida no registo.
  const { force, ...input } = rawInput;
  let idx = findClienteIndex({
    id: input.id ?? "",
    cpf: input.cpf,
    rastreameMotoristaKey: input.rastreameMotoristaKey,
    cnh: input.cnh,
  });
  // Fallback por nome normalizado: evita duplicar quem já existe localmente mas
  // não casou por CPF/CNH (ex.: CPF com dígito trocado, ou registo local sem CNH).
  if (idx < 0 && input.nome) {
    const nk = normNomeKey(input.nome);
    if (nk) idx = db.clientes.findIndex((c) => normNomeKey(c.nome) === nk);
  }

  if (idx < 0) {
    const registro: ClienteRegistro = {
      ...input,
      id: crypto.randomUUID(),
      nome: String(input.nome ?? "").trim(),
      rastreameMotoristaKey: input.rastreameMotoristaKey,
      rastreameMotoristaId: input.rastreameMotoristaId ?? undefined,
      rastreameSyncEm: ts,
      ativo: input.ativo !== false,
      origemImportacao: String(input.origemImportacao ?? "rastreame"),
      atualizadoEm: ts,
    };
    db.clientes.push(registro);
    saveClientesDb(db);
    return { registro, acao: "novo", aviso: null };
  }

  const existente = db.clientes[idx]!;
  if (
    !force &&
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

  let merged: ClienteRegistro;
  if (force) {
    // Rastreame sobrescreve (espelho exato), preservando subcampos locais ausentes no Rastreame.
    merged = { ...existente, ...input } as ClienteRegistro;
    if (input.cnh && typeof input.cnh === "object") {
      merged.cnh = { ...(existente.cnh as object), ...(input.cnh as object) };
    }
    if (input.endereco && typeof input.endereco === "object") {
      merged.endereco = { ...(existente.endereco as object), ...(input.endereco as object) };
    }
  } else {
    // Padrão não-destrutivo: só preenche lacunas locais, mantém dados locais mais ricos
    // (CNH completa de scan, endereço) — o Rastreame não tem esses campos.
    merged = fillGaps(existente, input as Record<string, unknown>) as ClienteRegistro;
  }

  merged.id = existente.id;
  merged.rastreameMotoristaKey = input.rastreameMotoristaKey;
  merged.rastreameMotoristaId =
    input.rastreameMotoristaId ?? existente.rastreameMotoristaId ?? undefined;
  merged.rastreameSyncEm = ts;
  merged.ativo = input.ativo !== false;
  if (input.nome && (!existente.nome || existente.origemImportacao === "rastreame")) {
    merged.nome = String(input.nome).trim();
  }

  const changed = JSON.stringify(existente) !== JSON.stringify(merged);
  db.clientes[idx] = merged;
  saveClientesDb(db);
  return { registro: merged, acao: changed ? "atualizado" : "sem_alteracao", aviso: null };
}

function gravarClienteScope(cliente: ClienteImportado): ClientesLoadScope {
  const scope: ClientesLoadScope = {};
  const id = cliente.id?.trim();
  if (id) {
    if (isEntityUuid(id)) scope.ids = [id];
    else scope.idOuCpf = id;
  }
  const cpf = cliente.cpf?.trim();
  if (cpf) scope.cpf = cpf;
  return scope;
}

async function loadClientesDbParaGravar(cliente: ClienteImportado): Promise<ClientesDb> {
  const empty: ClientesDb = {
    descricao: DEFAULT_DESCRICAO,
    atualizadoEm: new Date().toISOString().slice(0, 10),
    clientes: [],
  };

  if (!(await useRelationalStore())) {
    return loadClientesDb();
  }

  const sqlFilter = clientesScopeFromFilter(gravarClienteScope(cliente));
  if (!sqlFilter) return empty;

  const clientes = (await queryClientesFromSql(sqlFilter)) as ClienteRegistro[];
  return { ...empty, clientes };
}

function applyGravarCliente(
  db: ClientesDb,
  cliente: ClienteImportado,
): UpsertClienteResult {
  const ts = nowIso();
  const idx = findClienteUpsertIndex(db, {
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
    herdarAnaliseCadastro(merged);
    db.clientes[idx] = merged;
    return { registro: merged, acao: "atualizado", aviso: null };
  }

  const registro: ClienteRegistro = {
    ...cliente,
    id: crypto.randomUUID(),
    nome: String(cliente.nome ?? "").trim(),
    atualizadoEm: ts,
    ativo: cliente.ativo !== false,
  };
  herdarAnaliseCadastro(registro);
  db.clientes.push(registro);
  return { registro, acao: "novo", aviso: null };
}

export function gravarCliente(
  cliente: ClienteImportado,
  opts?: { syncRastreame?: boolean },
): UpsertClienteResult {
  const db = loadClientesDb();
  const r = applyGravarCliente(db, cliente);
  saveClientesDb(db);
  void opts?.syncRastreame;
  return r;
}

export async function gravarClienteAsync(
  cliente: ClienteImportado,
  opts?: { syncRastreame?: boolean },
): Promise<UpsertClienteResult> {
  void opts?.syncRastreame;

  if (await useRelationalStore()) {
    const db = await loadClientesDbParaGravar(cliente);
    const r = applyGravarCliente(db, cliente);
    await herdarAnaliseCadastroAsync(r.registro);
    await upsertClienteToSql(r.registro as unknown as Record<string, unknown>);
    return r;
  }

  const db = loadClientesDb();
  const r = applyGravarCliente(db, cliente);
  await herdarAnaliseCadastroAsync(r.registro);
  saveClientesDb(db);
  return r;
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
  if (rastreameKey != null) c.rastreameMotoristaKey = String(rastreameKey);
  if (rastreameId != null) c.rastreameMotoristaId = rastreameId;
  c.rastreameSyncEm = nowIso();
  db.clientes[idx] = c;
  saveClientesDb(db);
  return c;
}

export async function marcarClienteRastreameSyncOkAsync(
  idOrCpf: string,
  rastreameKey?: string | number,
  rastreameId?: string | number,
): Promise<ClienteRegistro | null> {
  const key = idOrCpf.trim();
  if (await useRelationalStore()) {
    const db = await loadClientesDbAsync({ idOuCpf: key });
    let idx = db.clientes.findIndex((c) => c.id === key);
    if (idx < 0) {
      const found = findClienteInDb(db, key);
      if (found) idx = db.clientes.findIndex((c) => c.id === found.id);
    }
    if (idx < 0) return null;
    const c = db.clientes[idx]!;
    if (rastreameKey != null) c.rastreameMotoristaKey = String(rastreameKey);
    if (rastreameId != null) c.rastreameMotoristaId = rastreameId;
    c.rastreameSyncEm = nowIso();
    db.clientes[idx] = c;
    await upsertClienteToSql(c as unknown as Record<string, unknown>);
    return c;
  }
  return marcarClienteRastreameSyncOk(key, rastreameKey, rastreameId);
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
