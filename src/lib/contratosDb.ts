import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { extrairContrato, fmtDataBr, resolverPastaContrato, type TipoContrato } from "./contratoExtrair.js";
import { compactPlaca, formatPlacaHyphen, placasIguais } from "./placa.js";
import { REPO_ROOT } from "./repoRoot.js";

export const DB_CONTRATOS = path.join(REPO_ROOT, "database", "contratos.json");
const DB_CLIENTES = path.join(REPO_ROOT, "database", "clientes.json");
const DB_VEICULOS = path.join(REPO_ROOT, "database", "veiculos.json");

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
export type MotivoEncerramento = "devolvido" | "recuperado" | "troca";

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
  dataFimPrevista: string;
  dataEncerramento?: string | null;
  /** true se encerramento antecipado (quebra de contrato / retenção caução). */
  quebraContrato?: boolean;
  /** Como o veículo saiu da locação: devolvido, recuperado ou troca (novo contrato com outro veículo). */
  motivoEncerramento?: MotivoEncerramento | null;
  status: "ativo" | "encerrado";
  prazoDias: number;
  tipoContrato: TipoContrato;
  diaPagamentoSemana: string | null;
  diaPagamentoMes: number | null;
  diaPagamentoTexto: string | null;
  valorSemanal: number | null;
  valorMensal: number | null;
  valorDiaria: number | null;
  valorCaucao: number;
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
  veiculoId: "Placa do veículo (ABC-1D23) — chave em veiculos.json",
  cliente: "Snapshot do locatário (clientes.json ou dados do contrato)",
  veiculo: "Snapshot do veículo (veiculos.json ou placa do contrato)",
  pastaContrato: "Pasta DD.MM.AAAA - Nome em contratosDir",
  clienteNome: "Nome do locatário",
  placa: "Placa do veículo",
  cpf: "CPF do locatário",
  dataInicio: "DD/MM/AAAA",
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
  cadastradoEm: "ISO 8601",
  atualizadoEm: "ISO 8601",
};

export type RegistrarContratoOpts = {
  dataEncerramento?: string | null;
  status?: "ativo" | "encerrado";
  /** Força versão (senão calcula automaticamente pelo par cliente + veículo). */
  versao?: number;
  contratoAnteriorId?: string | null;
  quebraContrato?: boolean;
  motivoEncerramento?: MotivoEncerramento | null;
};

export type EncerrarContratoDbOpts = {
  dataEncerramento: string;
  motivoEncerramento: MotivoEncerramento;
  quebraContrato?: boolean;
};

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
  cpf: string;
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
    cpf: c.cpf,
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

function resolveCliente(cpf: string | null, nomePasta: string): ContratoCliente {
  const nomeLimpo = stripPastaSuffix(nomePasta);
  if (fs.existsSync(DB_CLIENTES)) {
    const db = JSON.parse(fs.readFileSync(DB_CLIENTES, "utf8")) as {
      clientes?: ClienteJson[];
    };
    const list = db.clientes ?? [];

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
  }

  return {
    id: null,
    nome: nomeLimpo,
    cpf,
  };
}

function resolveVeiculo(placa: string): ContratoVeiculo {
  const placaFmt = formatPlacaHyphen(placa);
  if (fs.existsSync(DB_VEICULOS)) {
    const db = JSON.parse(fs.readFileSync(DB_VEICULOS, "utf8")) as {
      veiculos?: VeiculoJson[];
    };
    const v = db.veiculos?.find((x) => placasIguais(x.placa, placaFmt));
    if (v) return snapshotVeiculo(v);

    const partial = compactPlaca(placaFmt);
    if (partial.length >= 3 && partial.length < 7) {
      const candidates =
        db.veiculos?.filter((x) => compactPlaca(x.placa).startsWith(partial)) ?? [];
      if (candidates.length === 1) return snapshotVeiculo(candidates[0]!);
    }
  }
  return { id: null, placa: placaFmt };
}

function loadClienteId(cpf: string | null): string | null {
  if (!cpf || !fs.existsSync(DB_CLIENTES)) return null;
  const db = JSON.parse(fs.readFileSync(DB_CLIENTES, "utf8")) as {
    clientes?: { id?: string; cpf?: string }[];
  };
  const key = cpf.replace(/\D/g, "");
  const c = db.clientes?.find((x) => x.cpf?.replace(/\D/g, "") === key);
  return c?.id ?? null;
}

function mesmoParClienteVeiculo(
  c: ContratoRegistro,
  clienteId: string | null,
  cpf: string | null,
  clienteNome: string,
  placa: string,
): boolean {
  if (!placasIguais(c.placa, placa)) return false;
  if (clienteId && c.clienteId && c.clienteId === clienteId) return true;
  if (cpf && c.cpf && normCpfDigits(c.cpf) === normCpfDigits(cpf)) return true;
  return normNome(c.clienteNome) === normNome(clienteNome);
}

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
  const irmaos = db.contratos.filter(
    (c) =>
      normPath(c.pastaContrato) !== pastaKey &&
      mesmoParClienteVeiculo(c, clienteId, cliente.cpf, cliente.nome, veiculo.placa),
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
  if (!fs.existsSync(DB_CONTRATOS)) {
    return {
      descricao: "Contratos de locação (ativos e encerrados). id = uuid.",
      atualizadoEm: new Date().toISOString().slice(0, 10),
      schemaContrato: DEFAULT_SCHEMA,
      contratos: [],
    };
  }
  const db = JSON.parse(fs.readFileSync(DB_CONTRATOS, "utf8")) as ContratosDb;
  if (!db.schemaContrato) db.schemaContrato = DEFAULT_SCHEMA;
  return db;
}

export function saveContratosDb(db: ContratosDb): void {
  db.atualizadoEm = new Date().toISOString().slice(0, 10);
  db.schemaContrato = DEFAULT_SCHEMA;
  fs.writeFileSync(DB_CONTRATOS, JSON.stringify(db, null, 2), "utf8");
}

function buildRegistro(
  ext: ReturnType<typeof extrairContrato>,
  existing: ContratoRegistro | undefined,
  opts: RegistrarContratoOpts,
  db: ContratosDb,
  pastaKey: string,
): ContratoRegistro {
  const ts = nowIso();
  const encerramento =
    opts.dataEncerramento !== undefined
      ? opts.dataEncerramento
      : (existing?.dataEncerramento ?? null);

  let status: "ativo" | "encerrado" = opts.status ?? existing?.status ?? "ativo";
  if (encerramento) status = "encerrado";
  else if (opts.status) status = opts.status;

  const cliente = resolveCliente(ext.cpf, ext.clienteNome);
  const veiculo = resolveVeiculo(ext.placa);
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
    clienteId: cliente.id ?? loadClienteId(ext.cpf),
    veiculoId: veiculo.placa,
    cliente,
    veiculo,
    pastaContrato: ext.pastaContrato,
    clienteNome: cliente.nome,
    placa: veiculo.placa,
    cpf: cliente.cpf,
    dataInicio: fmtDataBr(ext.inicio),
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

function findContratoIndex(db: ContratosDb, pastaOrId: string): number {
  const key = pastaOrId.trim();
  if (/^[0-9a-f-]{36}$/i.test(key)) {
    return db.contratos.findIndex((c) => c.id === key);
  }
  const pastaKey = normPath(path.resolve(key));
  return db.contratos.findIndex((c) => normPath(c.pastaContrato) === pastaKey);
}

/** Efetiva encerramento no database/contratos.json (após relatório de acerto). */
export function encerrarContratoDb(
  pastaOrId: string,
  opts: EncerrarContratoDbOpts,
): ContratoRegistro {
  const db = loadContratosDb();
  const idx = findContratoIndex(db, pastaOrId);
  if (idx < 0) {
    return registrarContrato(path.resolve(pastaOrId), {
      dataEncerramento: opts.dataEncerramento.trim(),
      motivoEncerramento: opts.motivoEncerramento,
      quebraContrato: opts.quebraContrato ?? false,
      status: "encerrado",
    });
  }
  const existing = db.contratos[idx]!;
  return registrarContrato(existing.pastaContrato, {
    dataEncerramento: opts.dataEncerramento.trim(),
    motivoEncerramento: opts.motivoEncerramento,
    quebraContrato: opts.quebraContrato ?? false,
    status: "encerrado",
  });
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
export function contratoMaisRecentePar(filtros: {
  placa: string;
  cpf?: string | null;
  clienteId?: string | null;
  clienteNome?: string;
}): ContratoRegistro | undefined {
  const list = listarContratosClienteVeiculo(filtros);
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
): ContratoRegistro | undefined {
  const pasta = resolverPastaContrato(pastaOuDocx);
  const pastaKey = normPath(pasta);
  const vigente = contratoMaisRecentePar({ placa, cpf, clienteNome });
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

/** Contratos do mesmo locatário + veículo (qualquer versão), ordenados por versão. */
export function listarContratosClienteVeiculo(filtros: {
  placa: string;
  cpf?: string | null;
  clienteId?: string | null;
  clienteNome?: string;
}): ContratoRegistro[] {
  const db = loadContratosDb();
  const placaFmt = formatPlacaHyphen(filtros.placa);
  const nome = filtros.clienteNome ?? "";
  return db.contratos
    .filter((c) =>
      mesmoParClienteVeiculo(
        c,
        filtros.clienteId ?? null,
        filtros.cpf ?? null,
        nome,
        placaFmt,
      ),
    )
    .sort((a, b) => (a.versao ?? 1) - (b.versao ?? 1));
}
