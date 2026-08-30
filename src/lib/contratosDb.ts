import path from "node:path";
import crypto from "node:crypto";

import { jsonDocumentExists, loadJsonDocument, loadJsonDocumentForApi, saveJsonDocument, saveJsonDocumentAsync, useRelationalStore, assertRelationalStore, loadContratosFromSql, queryContratosFromSql, saveContratosToSql, upsertContratoToSql, deleteContratoFromSql, type ContratosSqlFilter } from "@lanza/db";
import { loadClientesDb, type ClienteRegistro } from "./clientesDb.js";
import { findClienteDbAsync, findClienteFromDadosAsync, findVeiculoDbAsync, findVeiculoFromDadosAsync, dadosParaContratoExtraido } from "./montarDadosContrato.js";
import type { GerarContratoDados } from "./docxGerar.js";
import { loadVeiculosDb, loadVeiculosDbAsync, type VeiculoRegistro } from "./veiculosDb.js";
import { extrairContrato, fmtDataBr, fmtHoraBr, resolverPastaContrato, type TipoContrato } from "./contratoExtrair.js";
import { parseDataBrOuIsoDia } from "./dataBr.js";
import { compactPlaca, formatPlacaHyphen, placasIguais } from "./placa.js";
import { isEntityUuid, resolveVeiculoIdListagem } from "./filtroListagem.js";
import { REPO_ROOT } from "./repoRoot.js";
import {
  MotivoEncerramento,
  StatusContrato,
  contratoOperacionalAtivo,
  type MotivoEncerramentoValor,
  type StatusContratoValor,
} from "./domain/index.js";

export { MotivoEncerramento, type MotivoEncerramentoValor };

export const DB_CONTRATOS = path.join(REPO_ROOT, "database", "contratos.json");

export type ContratoCliente = {
  id: string | null;
  nome: string;
  cpf: string | null;
  rg?: string | null;
  telefone?: string | null;
  email?: string | null;
  cnh?: {
    categoria?: string | null;
    validade?: string | null;
  };
  endereco?: {
    cep?: string | null;
    logradouro?: string | null;
    numero?: string | null;
    complemento?: string | null;
    bairro?: string | null;
    cidade?: string | null;
    uf?: string | null;
  };
};

export type ContratoVeiculo = {
  id: string | null;
  placa: string;
  marcaModelo?: string | null;
  fipeModelo?: string | null;
  anoModelo?: string | null;
  chassi?: string | null;
  renavam?: string | null;
  cor?: string | null;
  fipeValor?: string | null;
};

/**
 * Como o veículo saiu da locação:
 * - `devolvido`: locatário devolveu o veículo.
 * - `recuperado`: veículo recolhido/recuperado.
 * - `troca`: troca de veículo — sempre gera um **novo contrato** para o mesmo cliente
 *   com **outro veículo** (não é quebra; a caução transfere para o novo contrato).
 */

export type ContratoRegistro = {
  id: string;
  /** Número sequencial por par cliente + veículo (1 = primeiro contrato, 2 = renovação, …). */
  versao: number;
  /** id do contrato imediatamente anterior (mesmo cliente + veículo), ou null se versao = 1. */
  contratoAnteriorId: string | null;
  clienteId: string | null;
  veiculoId: string;
  cliente: ContratoCliente;
  veiculo: ContratoVeiculo;
  pastaContrato: string;
  clienteNome: string;
  placa: string;
  cpf: string | null;
  dataInicio: string;
  horaInicio?: string | null;
  dataFimPrevista: string;
  dataEncerramento?: string | null;
  /** true se encerramento antecipado (quebra de contrato / retenção caução). */
  quebraContrato?: boolean;
  /** Como o veículo saiu da locação: devolvido, recuperado ou troca (novo contrato com outro veículo). */
  motivoEncerramento?: MotivoEncerramentoValor | null;
  status: StatusContratoValor;
  prazoDias: number;
  tipoContrato: TipoContrato;
  diaPagamentoSemana: string | null;
  diaPagamentoMes: number | null;
  diaPagamentoTexto: string | null;
  valorSemanal: number | null;
  valorMensal: number | null;
  valorDiaria: number | null;
  valorCaucao: number;
  /** Vercel Blob pathname — contrato assinado (PDF/DOCX). */
  contratoAssinadoStorageKey?: string | null;
  /** Nome original do ficheiro do contrato assinado. */
  contratoAssinadoNome?: string | null;
  /** Blob pathname — última versão Word gerada. */
  documentoDocxStorageKey?: string | null;
  /** Blob pathname — última versão PDF gerada. */
  documentoPdfStorageKey?: string | null;
  /** ISO — quando Word/PDF foram gerados pela última vez. */
  documentoGeradoEm?: string | null;
  /** Nome base do documento gerado (sem extensão). */
  documentoGeradoNome?: string | null;
  /** Número da última versão Word/PDF gerada (1, 2, 3 …). */
  documentoGeradoVersao?: number | null;
  /**
   * Acordo operacional: vencimentos com data ≤ este valor não entram em juros/multa
   * nem na base de bloqueio do veículo (DD/MM/AAAA). Só vencimentos **após** esta data.
   */
  dataInicioJurosMultaBr?: string | null;
  cadastradoEm: string;
  atualizadoEm: string;
};

type ContratosDb = {
  descricao?: string;
  atualizadoEm?: string;
  schemaContrato?: Record<string, string>;
  contratos: ContratoRegistro[];
};

const DEFAULT_SCHEMA: Record<string, string> = {
  id: "uuid",
  versao: "Número sequencial por par cliente + veículo (1, 2, 3 … — renovações)",
  contratoAnteriorId: "uuid do contrato anterior (null se versao = 1)",
  clienteId: "uuid -> clientes.json (null se não vinculado)",
  veiculoId: "UUID do veículo (FK lanza.veiculos.id)",
  cliente: "Snapshot do locatário (clientes.json ou dados do contrato)",
  veiculo: "Snapshot do veículo (veiculos.json ou placa do contrato)",
  pastaContrato: "Pasta DD.MM.AAAA - Nome em contratosDir",
  clienteNome: "Nome do locatário",
  placa: "Placa do veículo",
  cpf: "CPF do locatário",
  dataInicio: "DD/MM/AAAA",
  horaInicio: "Horário de início/fim da locação (HH:MM) — padrão 18:00",
  dataFimPrevista: "DD/MM/AAAA — fim previsto no contrato",
  dataEncerramento: "DD/MM/AAAA — devolução/encerramento real (null se ativo)",
  quebraContrato: "true se houve quebra de contrato (encerramento antes do fim previsto)",
  motivoEncerramento: "devolvido | recuperado | troca — null se contrato ativo (troca = novo contrato com outro veículo)",
  status: "ativo | encerrado",
  prazoDias: "Duração contratual em dias",
  tipoContrato: "semanal | diaria | mensal",
  diaPagamentoSemana:
    "Dia da semana (segunda, terca, quarta, quinta, sexta, sabado, domingo) — contrato semanal",
  diaPagamentoMes: "Dia numérico 1–31 — contrato mensal",
  diaPagamentoTexto: "Trecho original do contrato (ex.: todas as segundas-feiras)",
  valorSemanal: "Valor semanal (R$) — null se não for semanal",
  valorMensal: "Valor mensal (R$) — null se não for mensal",
  valorDiaria: "Valor diário (R$) — null se não for diária",
  valorCaucao: "Caução (R$)",
  contratoAssinadoStorageKey: "Vercel Blob — contrato assinado (PDF/DOCX)",
  contratoAssinadoNome: "Nome do ficheiro do contrato assinado",
  dataInicioJurosMultaBr:
    "DD/MM/AAAA — vencimentos até esta data ficam sem juros/multa e fora da base de bloqueio (acordo)",
  cadastradoEm: "ISO 8601",
  atualizadoEm: "ISO 8601",
};

export type RegistrarContratoOpts = {
  dataEncerramento?: string | null;
  status?: StatusContratoValor;
  /** Força versão (senão calcula automaticamente pelo par cliente + veículo). */
  versao?: number;
  contratoAnteriorId?: string | null;
  quebraContrato?: boolean;
  motivoEncerramento?: MotivoEncerramentoValor | null;
};

export type EncerrarContratoDbOpts = {
  dataEncerramento: string;
  motivoEncerramento: MotivoEncerramentoValor;
  quebraContrato?: boolean;
};

/** Contrato em locação ativa (status ativo e sem data de encerramento). */
export function contratoAtivoOperacional(c: ContratoRegistro): boolean {
  return contratoOperacionalAtivo(c);
}

/** Contrato ativo cujo fim previsto ainda não passou (ou sem fim previsto). */
export function contratoDentroPrazoPrevisto(
  c: ContratoRegistro,
  ref: Date = new Date(),
): boolean {
  if (!contratoAtivoOperacional(c)) return false;
  const fimStr = String(c.dataFimPrevista ?? "").trim();
  if (!fimStr) return true;
  const fim = parseDataBrOuIsoDia(fimStr);
  if (!fim) return true;
  const fimDia = new Date(fim.getFullYear(), fim.getMonth(), fim.getDate(), 23, 59, 59, 999);
  const refDia = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), 12, 0, 0, 0);
  return refDia <= fimDia;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normPath(p: string): string {
  return path.normalize(p).toLowerCase();
}

function normCpfDigits(cpf: string): string {
  return cpf.replace(/\D/g, "");
}

function normNome(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

type ClienteJson = {
  id?: string;
  nome: string;
  cpf?: string | null;
  rg?: string | null;
  telefone?: string | null;
  email?: string | null;
  cnh?: { categoria?: string | null; validade?: string | null };
  endereco?: ContratoCliente["endereco"];
};

type VeiculoJson = {
  id?: string;
  placa: string;
  marcaModelo?: string;
  fipeModelo?: string;
  anoModelo?: string;
  chassi?: string;
  renavam?: string;
  cor?: string;
  fipeValor?: string;
};

function snapshotCliente(c: ClienteJson): ContratoCliente {
  return {
    id: c.id ?? null,
    nome: c.nome,
    cpf: c.cpf ?? null,
    rg: c.rg ?? null,
    telefone: c.telefone ?? null,
    email: c.email ?? null,
    cnh: c.cnh
      ? { categoria: c.cnh.categoria ?? null, validade: c.cnh.validade ?? null }
      : undefined,
    endereco: c.endereco,
  };
}

function snapshotVeiculo(v: VeiculoJson): ContratoVeiculo {
  return {
    id: v.id ?? null,
    placa: formatPlacaHyphen(v.placa),
    marcaModelo: v.marcaModelo ?? null,
    fipeModelo: v.fipeModelo ?? null,
    anoModelo: v.anoModelo ?? null,
    chassi: v.chassi ?? null,
    renavam: v.renavam ?? null,
    cor: v.cor ?? null,
    fipeValor: v.fipeValor ?? null,
  };
}

function stripPastaSuffix(nome: string): string {
  return nome
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveClienteFromList(
  list: ClienteRegistro[],
  cpf: string | null,
  nomePasta: string,
): ContratoCliente {
  const nomeLimpo = stripPastaSuffix(nomePasta);

  const n = normNome(nomeLimpo);
  const matches = list.filter((x) => {
    const xn = normNome(x.nome);
    return xn === n || xn.includes(n) || n.includes(xn);
  });
  if (matches.length === 1) return snapshotCliente(matches[0]!);

  if (cpf) {
    const key = normCpfDigits(cpf);
    const c = list.find((x) => x.cpf && normCpfDigits(x.cpf) === key);
    if (c) {
      const xn = normNome(c.nome);
      if (xn === n || xn.includes(n) || n.includes(xn)) return snapshotCliente(c);
    }
  }

  return {
    id: null,
    nome: nomeLimpo,
    cpf,
  };
}

function resolveCliente(cpf: string | null, nomePasta: string): ContratoCliente {
  return resolveClienteFromList(loadClientesDb().clientes, cpf, nomePasta);
}

function resolveVeiculoFromList(list: VeiculoRegistro[], placa: string): ContratoVeiculo {
  const placaFmt = formatPlacaHyphen(placa);
  const v = list.find((x) => placasIguais(x.placa, placaFmt));
  if (v) return snapshotVeiculo(v);

  const partial = compactPlaca(placaFmt);
  if (partial.length >= 3 && partial.length < 7) {
    const candidates = list.filter((x) => compactPlaca(x.placa).startsWith(partial));
    if (candidates.length === 1) return snapshotVeiculo(candidates[0]!);
  }
  return { id: null, placa: placaFmt };
}

function resolveVeiculo(placa: string): ContratoVeiculo {
  return resolveVeiculoFromList(loadVeiculosDb().veiculos, placa);
}

function loadClienteIdFromList(list: ClienteRegistro[], cpf: string | null): string | null {
  if (!cpf) return null;
  const key = cpf.replace(/\D/g, "");
  const c = list.find((x) => x.cpf?.replace(/\D/g, "") === key);
  return c?.id ?? null;
}

function loadClienteId(cpf: string | null): string | null {
  return loadClienteIdFromList(loadClientesDb().clientes, cpf);
}

function contratoMesmoVeiculo(
  c: ContratoRegistro,
  veiculoId: string | null,
  placa: string,
): boolean {
  if (veiculoId && isEntityUuid(veiculoId) && isEntityUuid(c.veiculoId)) {
    return c.veiculoId === veiculoId;
  }
  if (veiculoId && c.veiculoId === veiculoId) return true;
  if (placa) return placasIguais(c.placa, placa);
  return false;
}

/** Contrato ativo na placa ou veiculoId do cadastro. */
export function contratoVinculadoVeiculo(
  c: ContratoRegistro,
  v: Pick<VeiculoRegistro, "id" | "placa">,
): boolean {
  return contratoMesmoVeiculo(c, v.id ?? null, v.placa ?? "");
}

function mesmoClienteContrato(
  c: ContratoRegistro,
  clienteId: string | null,
  cpf: string | null,
  clienteNome: string,
): boolean {
  if (clienteId && c.clienteId && c.clienteId === clienteId) return true;
  if (cpf && c.cpf && normCpfDigits(c.cpf) === normCpfDigits(cpf)) return true;
  if (clienteNome.trim()) return normNome(c.clienteNome) === normNome(clienteNome);
  return false;
}

function mesmoParClienteVeiculo(
  c: ContratoRegistro,
  clienteId: string | null,
  cpf: string | null,
  clienteNome: string,
  veiculoId: string | null,
  placa: string,
): boolean {
  if (!contratoMesmoVeiculo(c, veiculoId, placa)) return false;
  return mesmoClienteContrato(c, clienteId, cpf, clienteNome);
}

export type FiltrosContratoCliente = {
  placa?: string;
  veiculoId?: string | null;
  cpf?: string | null;
  clienteId?: string | null;
  clienteNome?: string;
  /** Contrato ativo selecionado na UI de renovação (permite trocar veículo). */
  contratoRenovarId?: string | null;
};

export type ValidarModoContratoResult = {
  irmaos: ContratoRegistro[];
  proximaVersao: number;
  contratoAnteriorId?: string | null;
};

function resolverVersao(
  db: ContratosDb,
  cliente: ContratoCliente,
  veiculo: ContratoVeiculo,
  pastaKey: string,
  existing: ContratoRegistro | undefined,
  opts: RegistrarContratoOpts,
): { versao: number; contratoAnteriorId: string | null } {
  if (existing?.versao != null && opts.versao === undefined) {
    return {
      versao: existing.versao,
      contratoAnteriorId: existing.contratoAnteriorId ?? null,
    };
  }

  if (opts.versao != null && opts.versao > 0) {
    return {
      versao: opts.versao,
      contratoAnteriorId: opts.contratoAnteriorId ?? existing?.contratoAnteriorId ?? null,
    };
  }

  const clienteId = cliente.id ?? loadClienteId(cliente.cpf);
  const veiculoId = veiculo.id ?? resolveVeiculoIdListagem({ placa: veiculo.placa }) ?? null;
  const irmaos = db.contratos.filter(
    (c) =>
      normPath(c.pastaContrato) !== pastaKey &&
      mesmoParClienteVeiculo(c, clienteId, cliente.cpf, cliente.nome, veiculoId, veiculo.placa),
  );

  if (irmaos.length === 0) {
    return { versao: 1, contratoAnteriorId: null };
  }

  const maxVersao = Math.max(...irmaos.map((c) => c.versao ?? 1));
  const anterior = irmaos.reduce((best, c) =>
    (c.versao ?? 1) >= (best.versao ?? 1) ? c : best,
  );
  return { versao: maxVersao + 1, contratoAnteriorId: anterior.id };
}

export function loadContratosDb(): ContratosDb {
  if (!jsonDocumentExists(DB_CONTRATOS)) {
    return {
      descricao: "Contratos de locação (ativos e encerrados). id = uuid.",
      atualizadoEm: new Date().toISOString().slice(0, 10),
      schemaContrato: DEFAULT_SCHEMA,
      contratos: [],
    };
  }
  const db = loadJsonDocument<ContratosDb>(DB_CONTRATOS);
  if (!db.schemaContrato) db.schemaContrato = DEFAULT_SCHEMA;
  return db;
}

export type ContratosLoadScope = ContratosSqlFilter;

function hasContratosScope(scope?: ContratosLoadScope): boolean {
  if (!scope) return false;
  return Boolean(
    scope.id?.trim() ||
      scope.pastaContrato?.trim() ||
      scope.status?.trim() ||
      scope.clienteId?.trim() ||
      scope.veiculoId?.trim() ||
      (scope.veiculoIds?.length ?? 0) > 0,
  );
}

function contratosScopeFromPastaOrId(pastaOrId: string): ContratosLoadScope {
  const key = pastaOrId.trim();
  if (/^[0-9a-f-]{36}$/i.test(key)) return { id: key };
  return { pastaContrato: normPath(path.resolve(key)) };
}

async function loadContratoDbParaMutacao(
  pastaOrId: string,
): Promise<{ db: ContratosDb; idx: number } | null> {
  if (await useRelationalStore()) {
    const db = await loadContratosDbAsync(contratosScopeFromPastaOrId(pastaOrId));
    const idx = findContratoIndex(db, pastaOrId);
    if (idx < 0) return null;
    return { db, idx };
  }
  const db = loadContratosDb();
  const idx = findContratoIndex(db, pastaOrId);
  if (idx < 0) return null;
  return { db, idx };
}

export async function loadContratosDbAsync(scope?: ContratosLoadScope): Promise<ContratosDb> {
  const empty: ContratosDb = {
    descricao: "Contratos de locação (ativos e encerrados). id = uuid.",
    atualizadoEm: new Date().toISOString().slice(0, 10),
    schemaContrato: DEFAULT_SCHEMA,
    contratos: [],
  };
  if (await useRelationalStore()) {
    if (hasContratosScope(scope)) {
      const contratos = (await queryContratosFromSql(scope!)) as ContratoRegistro[];
      return { ...empty, contratos, schemaContrato: DEFAULT_SCHEMA };
    }
    return (await loadContratosFromSql()) as ContratosDb;
  }
  const db = await loadJsonDocumentForApi<ContratosDb>(DB_CONTRATOS, empty);
  if (!db.schemaContrato) db.schemaContrato = DEFAULT_SCHEMA;
  return db;
}

export function findContratoInDb(db: ContratosDb, id: string): ContratoRegistro | null {
  const key = id.trim();
  return db.contratos.find((c) => c.id === key) ?? null;
}

export function saveContratosDb(db: ContratosDb): void {
  db.atualizadoEm = new Date().toISOString().slice(0, 10);
  db.schemaContrato = DEFAULT_SCHEMA;
  saveJsonDocument(DB_CONTRATOS, db);
}

export async function saveContratosDbAsync(db: ContratosDb): Promise<void> {
  db.atualizadoEm = new Date().toISOString().slice(0, 10);
  db.schemaContrato = DEFAULT_SCHEMA;
  await assertRelationalStore();
  await saveContratosToSql(db);
}

type RegistrarCatalogo = {
  clientes: ClienteRegistro[];
  veiculos: VeiculoRegistro[];
};

function buildRegistro(
  ext: ReturnType<typeof extrairContrato>,
  existing: ContratoRegistro | undefined,
  opts: RegistrarContratoOpts,
  db: ContratosDb,
  pastaKey: string,
  catalogo?: RegistrarCatalogo,
): ContratoRegistro {
  const ts = nowIso();
  const encerramento =
    opts.dataEncerramento !== undefined
      ? opts.dataEncerramento
      : (existing?.dataEncerramento ?? null);

  let status: StatusContratoValor = opts.status ?? existing?.status ?? StatusContrato.Ativo;
  if (encerramento) status = StatusContrato.Encerrado;
  else if (opts.status) status = opts.status;

  const clientes = catalogo?.clientes ?? loadClientesDb().clientes;
  const veiculos = catalogo?.veiculos ?? loadVeiculosDb().veiculos;
  const cliente = resolveClienteFromList(clientes, ext.cpf, ext.clienteNome);
  const veiculo = resolveVeiculoFromList(veiculos, ext.placa);
  const { versao, contratoAnteriorId } = resolverVersao(
    db,
    cliente,
    veiculo,
    pastaKey,
    existing,
    opts,
  );

  return {
    id: existing?.id ?? crypto.randomUUID(),
    versao,
    contratoAnteriorId,
    clienteId: cliente.id ?? loadClienteIdFromList(clientes, ext.cpf),
    veiculoId: veiculo.id ?? resolveVeiculoIdListagem({ placa: veiculo.placa }, veiculos) ?? veiculo.placa,
    cliente,
    veiculo,
    pastaContrato: ext.pastaContrato,
    clienteNome: cliente.nome,
    placa: veiculo.placa,
    cpf: cliente.cpf,
    dataInicio: fmtDataBr(ext.inicio),
    horaInicio: ext.horaInicio?.trim() || fmtHoraBr(ext.inicio) || "18:00",
    dataFimPrevista: fmtDataBr(ext.fim),
    dataEncerramento: encerramento,
    quebraContrato: opts.quebraContrato ?? existing?.quebraContrato ?? false,
    motivoEncerramento:
      opts.motivoEncerramento !== undefined
        ? opts.motivoEncerramento
        : (existing?.motivoEncerramento ?? null),
    status,
    prazoDias: ext.prazoDias,
    tipoContrato: ext.tipoContrato,
    diaPagamentoSemana: ext.diaPagamentoSemana,
    diaPagamentoMes: ext.diaPagamentoMes,
    diaPagamentoTexto: ext.diaPagamentoTexto,
    valorSemanal: ext.valorSemanal,
    valorMensal: ext.valorMensal,
    valorDiaria: ext.valorDiaria,
    valorCaucao: ext.valorCaucao,
    cadastradoEm: existing?.cadastradoEm ?? ts,
    atualizadoEm: ts,
  };
}

/** Cadastra ou atualiza contrato a partir da pasta/docx (extrai todos os campos). */
export function registrarContrato(
  pastaContrato: string,
  opts: RegistrarContratoOpts = {},
): ContratoRegistro {
  const ext = extrairContrato(pastaContrato);
  const db = loadContratosDb();
  const pastaKey = normPath(ext.pastaContrato);
  const idx = db.contratos.findIndex((c) => normPath(c.pastaContrato) === pastaKey);
  const existing = idx >= 0 ? db.contratos[idx] : undefined;
  const registro = buildRegistro(ext, existing, opts, db, pastaKey);

  if (idx >= 0) db.contratos[idx] = registro;
  else db.contratos.push(registro);

  saveContratosDb(db);
  return registro;
}

export async function registrarContratoAsync(
  pastaContrato: string,
  opts: RegistrarContratoOpts = {},
): Promise<ContratoRegistro> {
  const ext = extrairContrato(pastaContrato);
  const [cliente, veiculo] = await Promise.all([
    findClienteDbAsync(ext.cpf ?? undefined, ext.clienteNome),
    findVeiculoDbAsync(ext.placa),
  ]);
  const veiculoIdResolved =
    veiculo.id ?? resolveVeiculoIdListagem({ placa: veiculo.placa }, [veiculo]) ?? null;
  const pastaKey = normPath(ext.pastaContrato);
  const catalogo = { clientes: [cliente], veiculos: [veiculo] };

  if (await useRelationalStore()) {
    let irmaos: ContratoRegistro[] = [];
    if (opts.versao == null && cliente.id && veiculoIdResolved) {
      irmaos = (await queryContratosFromSql({
        clienteId: cliente.id,
        veiculoId: veiculoIdResolved,
      })) as ContratoRegistro[];
    }
    const byPasta = (await queryContratosFromSql({
      pastaContrato: pastaKey,
    })) as ContratoRegistro[];
    const existing = byPasta[0];
    const db: ContratosDb = {
      descricao: "Contratos de locação (ativos e encerrados). id = uuid.",
      atualizadoEm: new Date().toISOString().slice(0, 10),
      schemaContrato: DEFAULT_SCHEMA,
      contratos: existing
        ? [...irmaos.filter((c) => c.id !== existing.id), existing]
        : irmaos,
    };
    const idx = existing ? db.contratos.findIndex((c) => c.id === existing.id) : -1;
    const registro = buildRegistro(
      ext,
      existing,
      opts,
      db,
      pastaKey,
      catalogo,
    );
    if (idx >= 0) db.contratos[idx] = registro;
    else db.contratos.push(registro);
    await assertRelationalStore();
    await upsertContratoToSql(registro as unknown as Record<string, unknown>);
    return registro;
  }

  const scope: ContratosLoadScope | undefined =
    cliente.id && veiculoIdResolved
      ? { clienteId: cliente.id, veiculoId: veiculoIdResolved }
      : undefined;
  const db = await loadContratosDbAsync(scope);
  const idx = db.contratos.findIndex((c) => normPath(c.pastaContrato) === pastaKey);
  const existing = idx >= 0 ? db.contratos[idx] : undefined;
  const registro = buildRegistro(ext, existing, opts, db, pastaKey, catalogo);
  if (idx >= 0) db.contratos[idx] = registro;
  else db.contratos.push(registro);
  await saveContratosDbAsync(db);
  return registro;
}

/** Cadastra ou atualiza contrato a partir dos dados do formulário (sem gerar/ler Word). */
export async function registrarContratoFromDadosAsync(
  dados: GerarContratoDados,
  opts: RegistrarContratoOpts = {},
): Promise<ContratoRegistro> {
  const ext = dadosParaContratoExtraido(dados);
  const [cliente, veiculo] = await Promise.all([
    findClienteFromDadosAsync(dados),
    findVeiculoFromDadosAsync(dados),
  ]);
  const veiculoIdResolved =
    veiculo.id ?? resolveVeiculoIdListagem({ placa: veiculo.placa }, [veiculo]) ?? null;
  const pastaKey = normPath(ext.pastaContrato);
  const catalogo = { clientes: [cliente], veiculos: [veiculo] };

  if (await useRelationalStore()) {
    let irmaos: ContratoRegistro[] = [];
    if (opts.versao == null && cliente.id && veiculoIdResolved) {
      irmaos = (await queryContratosFromSql({
        clienteId: cliente.id,
        veiculoId: veiculoIdResolved,
      })) as ContratoRegistro[];
    }
    const byPasta = (await queryContratosFromSql({
      pastaContrato: pastaKey,
    })) as ContratoRegistro[];
    const existing = byPasta[0];
    const db: ContratosDb = {
      descricao: "Contratos de locação (ativos e encerrados). id = uuid.",
      atualizadoEm: new Date().toISOString().slice(0, 10),
      schemaContrato: DEFAULT_SCHEMA,
      contratos: existing
        ? [...irmaos.filter((c) => c.id !== existing.id), existing]
        : irmaos,
    };
    const idx = existing ? db.contratos.findIndex((c) => c.id === existing.id) : -1;
    const registro = buildRegistro(ext, existing, opts, db, pastaKey, catalogo);
    if (idx >= 0) db.contratos[idx] = registro;
    else db.contratos.push(registro);
    await assertRelationalStore();
    await upsertContratoToSql(registro as unknown as Record<string, unknown>);
    return registro;
  }

  const scope: ContratosLoadScope | undefined =
    cliente.id && veiculoIdResolved
      ? { clienteId: cliente.id, veiculoId: veiculoIdResolved }
      : undefined;
  const db = await loadContratosDbAsync(scope);
  const idx = db.contratos.findIndex((c) => normPath(c.pastaContrato) === pastaKey);
  const existing = idx >= 0 ? db.contratos[idx] : undefined;
  const registro = buildRegistro(ext, existing, opts, db, pastaKey, catalogo);
  if (idx >= 0) db.contratos[idx] = registro;
  else db.contratos.push(registro);
  await saveContratosDbAsync(db);
  return registro;
}

function findContratoIndex(db: ContratosDb, pastaOrId: string): number {
  const key = pastaOrId.trim();
  if (/^[0-9a-f-]{36}$/i.test(key)) {
    return db.contratos.findIndex((c) => c.id === key);
  }
  const pastaKey = normPath(path.resolve(key));
  return db.contratos.findIndex((c) => normPath(c.pastaContrato) === pastaKey);
}

function applyEncerramentoContrato(
  registro: ContratoRegistro,
  opts: EncerrarContratoDbOpts,
): ContratoRegistro {
  return {
    ...registro,
    dataEncerramento: opts.dataEncerramento.trim(),
    motivoEncerramento: opts.motivoEncerramento,
    quebraContrato: opts.quebraContrato ?? registro.quebraContrato ?? false,
    status: StatusContrato.Encerrado,
    atualizadoEm: nowIso(),
  };
}

/** Efetiva encerramento no database/contratos.json (após relatório de acerto). */
export function encerrarContratoDb(
  pastaOrId: string,
  opts: EncerrarContratoDbOpts,
): ContratoRegistro {
  const db = loadContratosDb();
  const idx = findContratoIndex(db, pastaOrId);
  if (idx < 0) {
    if (process.env.VERCEL) {
      throw new Error(`Contrato não encontrado: ${pastaOrId}`);
    }
    return registrarContrato(path.resolve(pastaOrId), {
      dataEncerramento: opts.dataEncerramento.trim(),
      motivoEncerramento: opts.motivoEncerramento,
      quebraContrato: opts.quebraContrato ?? false,
      status: StatusContrato.Encerrado,
    });
  }
  const registro = applyEncerramentoContrato(db.contratos[idx]!, opts);
  db.contratos[idx] = registro;
  saveContratosDb(db);
  return registro;
}

export async function encerrarContratoDbAsync(
  pastaOrId: string,
  opts: EncerrarContratoDbOpts,
): Promise<ContratoRegistro> {
  const loaded = await loadContratoDbParaMutacao(pastaOrId);
  if (!loaded) {
    if (process.env.VERCEL) {
      throw new Error(`Contrato não encontrado: ${pastaOrId}`);
    }
    return encerrarContratoDb(pastaOrId, opts);
  }
  const { db, idx } = loaded;
  const registro = applyEncerramentoContrato(db.contratos[idx]!, opts);
  db.contratos[idx] = registro;
  if (await useRelationalStore()) {
    await assertRelationalStore();
    await upsertContratoToSql(registro as unknown as Record<string, unknown>);
    return registro;
  }
  await saveContratosDbAsync(db);
  return registro;
}

export type AtualizarContratoDbPatch = Partial<
  Pick<
    ContratoRegistro,
    | "dataInicio"
    | "horaInicio"
    | "dataFimPrevista"
    | "prazoDias"
    | "dataEncerramento"
    | "motivoEncerramento"
    | "quebraContrato"
    | "status"
    | "tipoContrato"
    | "diaPagamentoSemana"
    | "diaPagamentoMes"
    | "diaPagamentoTexto"
    | "valorSemanal"
    | "valorMensal"
    | "valorDiaria"
    | "valorCaucao"
    | "contratoAssinadoStorageKey"
    | "contratoAssinadoNome"
    | "documentoDocxStorageKey"
    | "documentoPdfStorageKey"
    | "documentoGeradoEm"
    | "documentoGeradoNome"
    | "documentoGeradoVersao"
  >
>;

/** Atualiza campos do registro em database/contratos.json (+ PostgreSQL em dual/postgres). */
export async function atualizarContratoDbAsync(
  id: string,
  patch: AtualizarContratoDbPatch,
): Promise<ContratoRegistro> {
  const loaded = await loadContratoDbParaMutacao(id);
  if (!loaded) {
    throw new Error(`Contrato não encontrado: ${id}`);
  }
  const { db, idx } = loaded;
  const atual = db.contratos[idx]!;
  const registro: ContratoRegistro = {
    ...atual,
    ...patch,
    atualizadoEm: nowIso(),
  };
  if (patch.dataEncerramento !== undefined && patch.dataEncerramento) {
    registro.status = StatusContrato.Encerrado;
  } else if (patch.status) {
    registro.status = patch.status;
  }
  db.contratos[idx] = registro;
  if (await useRelationalStore()) {
    await assertRelationalStore();
    await upsertContratoToSql(registro as unknown as Record<string, unknown>);
    return registro;
  }
  await saveContratosDbAsync(db);
  return registro;
}

/** Remove registro de database/contratos.json (não apaga pasta Word). */
export function excluirContrato(pastaOrId: string): ContratoRegistro {
  const db = loadContratosDb();
  const idx = findContratoIndex(db, pastaOrId);
  if (idx < 0) {
    throw new Error(`Contrato não encontrado: ${pastaOrId}`);
  }
  const [removido] = db.contratos.splice(idx, 1);
  saveContratosDb(db);
  return removido!;
}

export async function excluirContratoAsync(pastaOrId: string): Promise<ContratoRegistro> {
  const loaded = await loadContratoDbParaMutacao(pastaOrId);
  if (!loaded) {
    throw new Error(`Contrato não encontrado: ${pastaOrId}`);
  }
  const { db, idx } = loaded;
  const [removido] = db.contratos.splice(idx, 1);
  if (await useRelationalStore()) {
    await assertRelationalStore();
    await deleteContratoFromSql(removido!.id);
    return removido!;
  }
  await saveContratosDbAsync(db);
  return removido!;
}

/** @deprecated use encerrarContratoDb */
export function registrarEncerramentoContrato(
  pastaContrato: string,
  dataEncerramento: string,
): ContratoRegistro {
  return encerrarContratoDb(pastaContrato, {
    dataEncerramento,
    motivoEncerramento: "devolvido",
    quebraContrato: true,
  });
}

/** Contrato de maior versão para o par locatário + veículo (renovações em pastas distintas). */
export function contratoMaisRecentePar(
  filtros: {
    placa?: string;
    veiculoId?: string | null;
    cpf?: string | null;
    clienteId?: string | null;
    clienteNome?: string;
  },
  contratos?: ContratoRegistro[],
  veiculos?: VeiculoRegistro[],
): ContratoRegistro | undefined {
  const list = listarContratosClienteVeiculo(filtros, contratos, veiculos);
  return list.length > 0 ? list[list.length - 1] : undefined;
}

/**
 * Quebra de contrato só vale para o registro mais recente (database/contratos.json).
 * Renovações anteriores (outras pastas / versões) não entram no relatório.
 */
export function validarContratoVigenteParaEncerramento(
  pastaOuDocx: string,
  placa: string,
  cpf: string | null,
  clienteNome: string,
  contratos?: ContratoRegistro[],
): ContratoRegistro | undefined {
  const pasta = resolverPastaContrato(pastaOuDocx);
  const pastaKey = normPath(pasta);
  const vigente = contratoMaisRecentePar({ placa, cpf, clienteNome }, contratos);
  if (!vigente) return undefined;

  if (normPath(vigente.pastaContrato) !== pastaKey) {
    throw new Error(
      `Quebra de contrato aplica-se só ao contrato mais recente (v${vigente.versao}).\n` +
        `Pasta informada: ${pasta}\n` +
        `Use: ${vigente.pastaContrato}`,
    );
  }
  return vigente;
}

export type ModoContratoCli = "criar" | "renovar";

/** Carrega só os contratos necessários à validação (Postgres), evitando full scan. */
async function loadContratosParaValidacaoAsync(
  filtros: FiltrosContratoCliente,
  veiculoIdResolved?: string | null,
): Promise<ContratoRegistro[]> {
  if (!(await useRelationalStore())) {
    return (await loadContratosDbAsync()).contratos;
  }

  let vid = veiculoIdResolved;
  if (vid === undefined) {
    if (filtros.veiculoId?.trim()) {
      vid = filtros.veiculoId.trim();
    } else if (filtros.placa?.trim()) {
      const veiculosDb = await loadVeiculosDbAsync({ placa: filtros.placa });
      vid = resolveVeiculoIdListagem({ placa: filtros.placa }, veiculosDb.veiculos) ?? null;
    } else {
      vid = null;
    }
  }
  const clienteId = filtros.clienteId?.trim() || null;
  const batches: ContratoRegistro[][] = [];

  if (clienteId && vid) {
    batches.push(
      (await queryContratosFromSql({ clienteId, veiculoId: vid })) as ContratoRegistro[],
    );
  }

  if (vid) {
    batches.push(
      (await queryContratosFromSql({ status: StatusContrato.Ativo, veiculoId: vid })) as ContratoRegistro[],
    );
  }

  const renovarId = filtros.contratoRenovarId?.trim();
  if (renovarId) {
    batches.push((await queryContratosFromSql({ id: renovarId })) as ContratoRegistro[]);
  }

  const byId = new Map<string, ContratoRegistro>();
  for (const c of batches.flat()) {
    byId.set(c.id, c);
  }
  return [...byId.values()];
}

/** Valida `criar` vs `renovar` antes de gerar Word/registro. */
function validarModoContratoComLista(
  modo: ModoContratoCli,
  filtros: FiltrosContratoCliente,
  contratos: ContratoRegistro[],
  veiculoIdResolved?: string | null,
  veiculos?: VeiculoRegistro[],
): ValidarModoContratoResult {
  const catalogoVeiculos = veiculos ?? loadVeiculosDb().veiculos;
  const irmaos = listarContratosClienteVeiculo(filtros, contratos, catalogoVeiculos);
  const ativo = irmaos.find((c) => c.status === StatusContrato.Ativo);
  const placaFmt = filtros.placa?.trim() ? formatPlacaHyphen(filtros.placa) : "";
  const vid =
    veiculoIdResolved ??
    (filtros.placa?.trim()
      ? resolveVeiculoIdListagem({ placa: filtros.placa }, catalogoVeiculos)
      : null) ??
    null;
  const rotuloVeiculo = placaFmt || "deste veículo";

  if (modo === "criar") {
    const ativoOutro = contratos.find(
      (c) =>
        c.status === StatusContrato.Ativo &&
        contratoMesmoVeiculo(c, vid, placaFmt) &&
        !mesmoParClienteVeiculo(
          c,
          filtros.clienteId ?? null,
          filtros.cpf ?? null,
          filtros.clienteNome ?? "",
          vid,
          placaFmt,
        ),
    );
    if (ativoOutro) {
      throw new Error(
        `Veículo ${rotuloVeiculo} já possui contrato ativo com ${ativoOutro.clienteNome}. Encerre o contrato vigente antes de cadastrar outro locatário.`,
      );
    }
    if (ativo) {
      throw new Error(
        `Contrato v${ativo.versao} ainda ativo para este cliente+veículo. Encerre antes ou use renovar após encerramento.`,
      );
    }
    if (irmaos.length > 0) {
      const maxV = Math.max(...irmaos.map((c) => c.versao ?? 1));
      throw new Error(
        `Já existem contrato(s) anteriores (até v${maxV}) para este cliente+veículo. Use: cadastro-contrato renovar …`,
      );
    }
    return { irmaos, proximaVersao: 1 };
  }

  const origemRenovacao = filtros.contratoRenovarId?.trim()
    ? contratos.find((c) => c.id === filtros.contratoRenovarId!.trim())
    : undefined;
  if (origemRenovacao) {
    if (
      !mesmoClienteContrato(
        origemRenovacao,
        filtros.clienteId ?? null,
        filtros.cpf ?? null,
        filtros.clienteNome ?? "",
      )
    ) {
      throw new Error("Contrato a renovar não pertence a este cliente.");
    }
    const trocaVeiculo = !contratoMesmoVeiculo(origemRenovacao, vid, placaFmt);
    if (trocaVeiculo) {
      const ativoOutro = contratos.find(
        (c) =>
          c.status === StatusContrato.Ativo &&
          contratoMesmoVeiculo(c, vid, placaFmt) &&
          !mesmoParClienteVeiculo(
            c,
            filtros.clienteId ?? null,
            filtros.cpf ?? null,
            filtros.clienteNome ?? "",
            vid,
            placaFmt,
          ),
      );
      if (ativoOutro) {
        throw new Error(
          `Veículo ${rotuloVeiculo} já possui contrato ativo com ${ativoOutro.clienteNome}. Encerre o contrato vigente antes de renovar com este veículo.`,
        );
      }
      if (irmaos.length > 0) {
        const maxVersao = Math.max(...irmaos.map((c) => c.versao ?? 1));
        return {
          irmaos,
          proximaVersao: maxVersao + 1,
          contratoAnteriorId: origemRenovacao.id,
        };
      }
      return { irmaos, proximaVersao: 1, contratoAnteriorId: origemRenovacao.id };
    }
  }

  if (irmaos.length === 0) {
    throw new Error(
      "Nenhum contrato anterior para este cliente+veículo. Use: cadastro-contrato criar …",
    );
  }
  if (ativo) {
    throw new Error(
      `Contrato v${ativo.versao} ainda ativo. Encerre antes de renovar (cadastro-contrato encerrar …).`,
    );
  }
  const maxVersao = Math.max(...irmaos.map((c) => c.versao ?? 1));
  return { irmaos, proximaVersao: maxVersao + 1 };
}

export function validarModoContrato(
  modo: ModoContratoCli,
  filtros: FiltrosContratoCliente,
): ValidarModoContratoResult {
  return validarModoContratoComLista(modo, filtros, loadContratosDb().contratos);
}

export async function validarModoContratoAsync(
  modo: ModoContratoCli,
  filtros: FiltrosContratoCliente,
): Promise<ValidarModoContratoResult> {
  const veiculoIdInput = filtros.veiculoId?.trim() || null;
  const placaInput = filtros.placa?.trim() || null;
  const veiculosDb = veiculoIdInput
    ? await loadVeiculosDbAsync({ veiculoId: veiculoIdInput })
    : placaInput
      ? await loadVeiculosDbAsync({ placa: placaInput })
      : { veiculos: [] as VeiculoRegistro[] };

  let veiculoIdResolved: string | null =
    veiculoIdInput ||
    (placaInput
      ? resolveVeiculoIdListagem({ placa: placaInput }, veiculosDb.veiculos) ?? null
      : null);

  const contratos = await loadContratosParaValidacaoAsync(filtros, veiculoIdResolved);
  return validarModoContratoComLista(
    modo,
    filtros,
    contratos,
    veiculoIdResolved,
    veiculosDb.veiculos,
  );
}

/** Encerra o contrato ativo antes de gerar a renovação (vN+1 ou troca de veículo). */
export async function encerrarContratoAtivoParaRenovarAsync(
  filtros: FiltrosContratoCliente,
  dataEncerramento: string,
): Promise<ContratoRegistro | null> {
  let ativo: ContratoRegistro | undefined;
  let veiculoIdNova: string | null = filtros.veiculoId?.trim() || null;
  const veiculosDb = filtros.placa?.trim()
    ? await loadVeiculosDbAsync({ placa: filtros.placa })
    : await loadVeiculosDbAsync();
  if (!veiculoIdNova && filtros.placa?.trim()) {
    veiculoIdNova =
      resolveVeiculoIdListagem({ placa: filtros.placa }, veiculosDb.veiculos) ?? null;
  }

  const renovarId = filtros.contratoRenovarId?.trim();
  if (renovarId) {
    let alvo: ContratoRegistro | undefined;
    if (await useRelationalStore()) {
      const rows = (await queryContratosFromSql({ id: renovarId })) as ContratoRegistro[];
      alvo = rows[0];
    } else {
      const db = await loadContratosDbAsync();
      alvo = db.contratos.find((c) => c.id === renovarId);
    }
    if (!alvo) throw new Error(`Contrato a renovar não encontrado: ${renovarId}`);
    if (alvo.status !== StatusContrato.Ativo) return null;
    if (
      !mesmoClienteContrato(
        alvo,
        filtros.clienteId ?? null,
        filtros.cpf ?? null,
        filtros.clienteNome ?? "",
      )
    ) {
      throw new Error("Contrato a renovar não pertence a este cliente.");
    }
    ativo = alvo;
  } else if (await useRelationalStore()) {
    const batches: ContratoRegistro[][] = [];
    const clienteId = filtros.clienteId?.trim() || null;
    if (clienteId && veiculoIdNova) {
      batches.push(
        (await queryContratosFromSql({ clienteId, veiculoId: veiculoIdNova })) as ContratoRegistro[],
      );
    }
    const byId = new Map<string, ContratoRegistro>();
    for (const c of batches.flat()) byId.set(c.id, c);
    const irmaos = listarContratosClienteVeiculo(
      filtros,
      [...byId.values()],
      veiculosDb.veiculos,
    );
    ativo = irmaos.find((c) => c.status === StatusContrato.Ativo);
  } else {
    const scope: ContratosLoadScope | undefined =
      filtros.clienteId?.trim() && veiculoIdNova
        ? { clienteId: filtros.clienteId.trim(), veiculoId: veiculoIdNova }
        : undefined;
    const db = await loadContratosDbAsync(scope);
    const irmaos = listarContratosClienteVeiculo(filtros, db.contratos, veiculosDb.veiculos);
    ativo = irmaos.find((c) => c.status === StatusContrato.Ativo);
  }

  if (!ativo) return null;
  const ref = ativo.id?.trim() || ativo.pastaContrato?.trim();
  if (!ref) throw new Error("Contrato ativo sem identificador para encerramento.");

  const placaNova = filtros.placa?.trim() ? formatPlacaHyphen(filtros.placa) : "";
  const trocaVeiculo = !contratoMesmoVeiculo(ativo, veiculoIdNova, placaNova);

  return encerrarContratoDbAsync(ref, {
    dataEncerramento,
    motivoEncerramento: trocaVeiculo ? "troca" : "devolvido",
    quebraContrato: false,
  });
}

/** Contratos do mesmo locatário + veículo (qualquer versão), ordenados por versão. */
export function listarContratosClienteVeiculo(
  filtros: {
    placa?: string;
    veiculoId?: string | null;
    cpf?: string | null;
    clienteId?: string | null;
    clienteNome?: string;
  },
  contratos?: ContratoRegistro[],
  veiculos?: VeiculoRegistro[],
): ContratoRegistro[] {
  const catalogo = veiculos ?? loadVeiculosDb().veiculos;
  const veiculoId =
    filtros.veiculoId?.trim() ||
    resolveVeiculoIdListagem({ placa: filtros.placa }, catalogo) ||
    null;
  const placaFmt = filtros.placa ? formatPlacaHyphen(filtros.placa) : "";
  const nome = filtros.clienteNome ?? "";
  return (contratos ?? loadContratosDb().contratos)
    .filter((c) =>
      mesmoParClienteVeiculo(
        c,
        filtros.clienteId ?? null,
        filtros.cpf ?? null,
        nome,
        veiculoId,
        placaFmt,
      ),
    )
    .sort((a, b) => (a.versao ?? 1) - (b.versao ?? 1));
}
