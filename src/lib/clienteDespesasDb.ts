import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { inferirCondutorInfracao, parseDataAutuacao } from "./inferirCondutorInfracao.js";
import { isCategoriaInfracao, stripAtrasado, tituloInfracaoBase } from "./infracaoTitulo.js";
import { formatPlacaHyphen } from "./placa.js";
import { REPO_ROOT } from "./repoRoot.js";

export const DB_CLIENTE_DESPESAS = path.join(
  REPO_ROOT,
  "database",
  "cliente-despesas.json",
);
const DB_INFRACOES_LEGACY = path.join(REPO_ROOT, "database", "infracoes.json");
const DB_MULTAS_LEGACY = path.join(REPO_ROOT, "database", "multas.json");

/** Categorias replicadas em Gastos Gerais (Rastreame, tipo OUTROS). */
export const CATEGORIAS_SYNC_RASTREAME = new Set([
  "Locação semanal",
  "Outros",
  "Caução",
  "Lavação",
  "Estacionamento",
  "Pedágio",
  "Manutenção",
  "Quebra contrato",
]);

/**
 * Categorias cujo condutor é inferido pelo contrato ativo na data
 * (mesmo vínculo das infrações: placa + dataAutuacao com hora).
 */
export function categoriaInfereCondutor(categoria: string | undefined | null): boolean {
  const c = (categoria ?? "Infração").trim();
  return c === "Infração" || c === "Pedágio";
}

export type ClienteDespesaRegistro = {
  id: string;
  categoria?: string;
  veiculoId: string;
  autoInfracao: string;
  /** Texto cru do DETRAN (ex.: "TRANSITAR EM VEL SUPERIOR À MÁXIMA…"). */
  descricao: string;
  /** Rótulo curto do Gastos Gerais (ex.: "Multa velocidade - 30/03/2026 09:40"). Só infrações. */
  titulo?: string;
  localInfracao: string;
  dataAutuacao: string;
  valorMulta: number;
  situacao: string;
  limiteDefesa: string;
  condutorId: string | null;
  condutorConfirmado: boolean;
  condutorContrato: string | null;
  /** true = sem contrato ativo na data (locação não identificada) — não cobrável a cliente. */
  condutorNaoIdentificado?: boolean;
  /** true = precisa revisão manual (ex.: infração sem data de autuação no DETRAN). */
  revisarManual?: boolean;
  /** Motivo da revisão manual (texto curto). */
  revisarMotivo?: string | null;
  paga?: boolean;
  pagaEm?: string | null;
  quitadaDetran?: boolean;
  /** ID do gasto em rastreame.com.br (Gastos Gerais). */
  rastreameId?: string | number | null;
  rastreameMotoristaKey?: string | null;
  rastreameRastreavelKey?: string | null;
  /** Data ISO do gasto no Rastreame (PUT/POST). */
  rastreameDataIso?: string | null;
  /** Tipo do gasto no Rastreame (OUTROS, DOCUMENTACAO, etc.) — preserva no push. */
  rastreameTipo?: string | null;
  /** Última sincronização bem-sucedida com o Rastreame. */
  rastreameSyncEm?: string | null;
  /** false = excluído (soft delete); não entra em acertos. */
  ativo?: boolean;
  cadastradoEm: string;
  atualizadoEm: string;
  origem: string;
};

export type ClienteDespesaInput = {
  autoInfracao: string;
  descricao: string;
  /** Rótulo curto opcional; se omitido em infrações, é derivado de descricao + dataAutuacao. */
  titulo?: string;
  localInfracao: string;
  dataAutuacao: string;
  valorMulta: number | string;
  situacao: string;
  limiteDefesa: string;
  categoria?: string;
  origem?: string;
  quitadaDetran?: boolean;
  paga?: boolean;
  pagaEm?: string | null;
  rastreameId?: string | number | null;
  rastreameMotoristaKey?: string | null;
  rastreameRastreavelKey?: string | null;
  rastreameDataIso?: string | null;
  rastreameTipo?: string | null;
};

/** @deprecated use ClienteDespesaRegistro */
export type InfracaoRegistro = ClienteDespesaRegistro;

/** @deprecated use ClienteDespesaInput */
export type InfracaoInput = ClienteDespesaInput;

type ClienteDespesasDb = {
  descricao?: string;
  atualizadoEm?: string;
  schemaClienteDespesa?: Record<string, string>;
  /** @deprecated leitura legacy */
  schemaInfracao?: Record<string, string>;
  clienteDespesas: ClienteDespesaRegistro[];
};

const DEFAULT_DESCRICAO =
  "Débitos a cobrar dos locatários/clientes: infrações, locação, caução, manutenção, lavação, quebra de contrato, estacionamento, pedágio, etc.";

const DEFAULT_SCHEMA: Record<string, string> = {
  id: "uuid",
  categoria:
    "Infração | Locação semanal | Caução | Manutenção | Lavação | Quebra contrato | Renegociação | Estacionamento | Pedágio | Outros",
  veiculoId: "Placa do veículo (ABC-1D23)",
  autoInfracao: "Chave natural (auto DETRAN ou id interno)",
  descricao: "Descrição do débito",
  localInfracao: "Local (infrações) ou vazio",
  dataAutuacao: "DD/MM/AAAA HH:mm ou data do débito",
  valorMulta: "Valor em reais",
  situacao: "Situação (DETRAN ou controle interno)",
  limiteDefesa: "DD/MM/AAAA (infrações) ou vencimento",
  condutorId: "uuid -> clientes.json (null se não identificado)",
  condutorConfirmado: "false no cadastro; true após confirmação do usuário ou inferência por vigência",
  condutorContrato: "Pasta do contrato usado na sugestão de condutor",
  condutorNaoIdentificado: "boolean — true se não há contrato ativo na data (não cobrável a cliente)",
  revisarManual: "boolean — true se precisa revisão manual (ex.: infração sem data de autuação)",
  revisarMotivo: "Motivo curto da revisão manual",
  paga: "boolean — quitada pelo locatário (default false)",
  pagaEm: "DD/MM/AAAA — quando foi paga (opcional)",
  quitadaDetran: "boolean — quitada no DETRAN (só infrações); não cobrar locatário",
  cadastradoEm: "ISO 8601",
  atualizadoEm: "ISO 8601",
  origem: "manual | portal | detran-sc | rastreame | ...",
  rastreameId: "id numérico em rastreame.com.br (Gastos Gerais)",
  rastreameMotoristaKey: "motorista.key no Rastreame",
  rastreameRastreavelKey: "rastreavel.key no Rastreame",
  rastreameDataIso: "data ISO do gasto no Rastreame",
  rastreameTipo: "tipo do gasto no Rastreame (OUTROS, DOCUMENTACAO, ...)",
  rastreameSyncEm: "ISO 8601 — última sync com Rastreame",
  ativo: "boolean — false = excluído (default true)",
};

function parseValor(v: number | string): number {
  if (typeof v === "number") return Math.round(v * 100) / 100;
  const s = String(v).replace(/R\$\s*/i, "").trim();
  const n = s.includes(",")
    ? parseFloat(s.replace(/\./g, "").replace(",", "."))
    : parseFloat(s);
  if (!Number.isFinite(n)) throw new Error(`Valor inválido: ${v}`);
  return Math.round(n * 100) / 100;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeRawDb(raw: Record<string, unknown>): ClienteDespesasDb {
  const rawList = (raw.clienteDespesas ?? raw.infracoes ?? raw.multas ?? []) as ClienteDespesaRegistro[];
  const clienteDespesas = rawList.map((r) => ({
    ...r,
    categoria: r.categoria ?? "Infração",
  }));
  return {
    descricao: (raw.descricao as string) || DEFAULT_DESCRICAO,
    atualizadoEm: (raw.atualizadoEm as string) || new Date().toISOString().slice(0, 10),
    schemaClienteDespesa:
      (raw.schemaClienteDespesa as Record<string, string>) ||
      (raw.schemaInfracao as Record<string, string>) ||
      (raw.schemaMulta as Record<string, string>) ||
      DEFAULT_SCHEMA,
    clienteDespesas,
  };
}

function migrateLegacyFile(from: string, remove: string): void {
  if (fs.existsSync(DB_CLIENTE_DESPESAS) || !fs.existsSync(from)) return;
  const raw = JSON.parse(fs.readFileSync(from, "utf8")) as Record<string, unknown>;
  saveClienteDespesasDb(normalizeRawDb(raw));
  fs.unlinkSync(remove);
}

function migrateLegacyIfNeeded(): void {
  if (!fs.existsSync(DB_CLIENTE_DESPESAS)) {
    if (fs.existsSync(DB_INFRACOES_LEGACY)) {
      migrateLegacyFile(DB_INFRACOES_LEGACY, DB_INFRACOES_LEGACY);
      return;
    }
    if (fs.existsSync(DB_MULTAS_LEGACY)) {
      migrateLegacyFile(DB_MULTAS_LEGACY, DB_MULTAS_LEGACY);
    }
  }
}

export function loadClienteDespesasDb(): ClienteDespesasDb {
  migrateLegacyIfNeeded();
  if (!fs.existsSync(DB_CLIENTE_DESPESAS)) {
    return {
      descricao: DEFAULT_DESCRICAO,
      atualizadoEm: new Date().toISOString().slice(0, 10),
      schemaClienteDespesa: DEFAULT_SCHEMA,
      clienteDespesas: [],
    };
  }
  const raw = JSON.parse(fs.readFileSync(DB_CLIENTE_DESPESAS, "utf8")) as Record<string, unknown>;
  return normalizeRawDb(raw);
}

export function saveClienteDespesasDb(db: ClienteDespesasDb): void {
  db.atualizadoEm = new Date().toISOString().slice(0, 10);
  if (!db.descricao) db.descricao = DEFAULT_DESCRICAO;
  fs.writeFileSync(DB_CLIENTE_DESPESAS, JSON.stringify(db, null, 2), "utf8");
}

/** @deprecated use loadClienteDespesasDb */
export function loadInfracoesDb(): ClienteDespesasDb {
  return loadClienteDespesasDb();
}

/** @deprecated use saveClienteDespesasDb */
export function saveInfracoesDb(db: ClienteDespesasDb): void {
  saveClienteDespesasDb(db);
}

export type GravarClienteDespesaResult = {
  registro: ClienteDespesaRegistro;
  aviso: string | null;
  duplicado: boolean;
};

export type SincronizarClienteDespesaResult = {
  registro: ClienteDespesaRegistro;
  aviso: string | null;
  acao: "novo" | "atualizado" | "sem_alteracao";
};

/** @deprecated */
export type GravarInfracaoResult = GravarClienteDespesaResult;

/** @deprecated */
export type SincronizarInfracaoResult = SincronizarClienteDespesaResult;

function registroChanged(
  a: ClienteDespesaRegistro,
  input: ClienteDespesaInput & { quitadaDetran?: boolean },
): boolean {
  return (
    a.situacao !== String(input.situacao).trim() ||
    a.valorMulta !== parseValor(input.valorMulta) ||
    a.limiteDefesa !== String(input.limiteDefesa).trim() ||
    a.descricao !== String(input.descricao).trim() ||
    a.localInfracao !== String(input.localInfracao).trim() ||
    (input.dataAutuacao ? a.dataAutuacao !== String(input.dataAutuacao).trim() : false) ||
    (input.quitadaDetran === true && a.quitadaDetran !== true) ||
    (input.quitadaDetran === false && a.quitadaDetran === true) ||
    (input.categoria ? a.categoria !== input.categoria : false)
  );
}

export type CondutorResolvido = {
  condutorId: string | null;
  condutorContrato: string | null;
  condutorConfirmado: boolean;
  naoIdentificado: boolean;
  aviso: string | null;
};

/**
 * Resolve o condutor de uma infração/pedágio pela **vigência do contrato**:
 * - contrato + cliente encontrados → vincula e **confirma**;
 * - **nenhum contrato ativo** na data → **"Não identificado"** (confirmado, sem cliente);
 * - contrato achado mas cliente fora de `clientes.json` → **pendente** (não confirma).
 *
 * Requer data de autuação válida — o chamador trata o caso sem data (revisão manual).
 */
export function resolverCondutorVigencia(
  veiculoId: string,
  dataAutuacao: string,
  prazoDias = 90,
): CondutorResolvido {
  const sug = inferirCondutorInfracao(veiculoId, dataAutuacao, prazoDias);
  if (sug.condutorId) {
    return {
      condutorId: sug.condutorId,
      condutorContrato: sug.condutorContrato,
      condutorConfirmado: true,
      naoIdentificado: false,
      aviso: sug.aviso,
    };
  }
  if (!sug.condutorContrato) {
    return {
      condutorId: null,
      condutorContrato: null,
      condutorConfirmado: true,
      naoIdentificado: true,
      aviso: sug.aviso,
    };
  }
  return {
    condutorId: null,
    condutorContrato: sug.condutorContrato,
    condutorConfirmado: false,
    naoIdentificado: false,
    aviso: sug.aviso,
  };
}

export function gravarClienteDespesa(
  veiculoIdRaw: string,
  input: ClienteDespesaInput,
  opts?: { prazoDias?: number; skipInferir?: boolean },
): GravarClienteDespesaResult {
  const db = loadClienteDespesasDb();
  const veiculoId = formatPlacaHyphen(veiculoIdRaw);
  const autoKey = String(input.autoInfracao).trim().toUpperCase();
  const categoria = input.categoria?.trim() || "Infração";

  const dup = db.clienteDespesas.find(
    (m) => m.autoInfracao.trim().toUpperCase() === autoKey,
  );
  if (dup) {
    return { registro: dup, aviso: "Auto já cadastrado", duplicado: true };
  }

  // Quitada no DETRAN não é cobrável do locatário: não inferimos condutor,
  // não marcamos revisão e damos condutorConfirmado=true (nada a vincular).
  const quitada = input.quitadaDetran === true;
  let condutorId: string | null = null;
  let condutorContrato: string | null = null;
  let aviso: string | null = null;
  let revisarManual = false;
  let condutorConfirmado = quitada;
  let naoIdentificado = false;

  if (!quitada && !opts?.skipInferir && categoriaInfereCondutor(categoria)) {
    const dataValida = parseDataAutuacao(String(input.dataAutuacao || ""));
    if (!dataValida) {
      // Sem data de autuação não dá para comparar com a vigência → revisar.
      aviso = `Data de autuação inválida: ${input.dataAutuacao}`;
      revisarManual = true;
    } else {
      const res = resolverCondutorVigencia(veiculoId, input.dataAutuacao, opts?.prazoDias ?? 90);
      condutorId = res.condutorId;
      condutorContrato = res.condutorContrato;
      condutorConfirmado = res.condutorConfirmado;
      naoIdentificado = res.naoIdentificado;
      aviso = res.aviso;
    }
  }

  const ts = nowIso();
  const registro: ClienteDespesaRegistro = {
    id: crypto.randomUUID(),
    categoria,
    veiculoId,
    autoInfracao: String(input.autoInfracao).trim(),
    descricao: String(input.descricao).trim(),
    localInfracao: String(input.localInfracao).trim(),
    dataAutuacao: String(input.dataAutuacao).trim(),
    valorMulta: parseValor(input.valorMulta),
    situacao: String(input.situacao).trim(),
    limiteDefesa: String(input.limiteDefesa).trim(),
    condutorId,
    condutorConfirmado,
    condutorContrato,
    cadastradoEm: ts,
    atualizadoEm: ts,
    origem: input.origem ?? "manual",
  };

  if (isCategoriaInfracao(categoria)) {
    registro.titulo =
      input.titulo?.trim() || tituloInfracaoBase(registro.descricao, registro.dataAutuacao);
  } else if (input.titulo?.trim()) {
    registro.titulo = input.titulo.trim();
  }

  if (revisarManual && !quitada) {
    registro.revisarManual = true;
    registro.revisarMotivo = "Sem data de autuação no DETRAN — revisar manualmente";
  }
  if (naoIdentificado) registro.condutorNaoIdentificado = true;
  if (input.quitadaDetran === true) registro.quitadaDetran = true;
  if (input.paga === true) registro.paga = true;
  if (input.paga === false) registro.paga = false;
  if (input.pagaEm !== undefined) registro.pagaEm = input.pagaEm;
  if (input.rastreameId != null) registro.rastreameId = input.rastreameId;
  if (input.rastreameMotoristaKey != null) {
    registro.rastreameMotoristaKey = input.rastreameMotoristaKey;
  }
  if (input.rastreameRastreavelKey != null) {
    registro.rastreameRastreavelKey = input.rastreameRastreavelKey;
  }
  if (input.rastreameDataIso != null) registro.rastreameDataIso = input.rastreameDataIso;
  if (input.rastreameTipo != null) registro.rastreameTipo = input.rastreameTipo;

  db.clienteDespesas.push(registro);
  saveClienteDespesasDb(db);
  return { registro, aviso, duplicado: false };
}

/** @deprecated use gravarClienteDespesa */
export function gravarInfracao(
  veiculoIdRaw: string,
  input: ClienteDespesaInput,
  opts?: { prazoDias?: number; skipInferir?: boolean },
): GravarClienteDespesaResult {
  return gravarClienteDespesa(veiculoIdRaw, { ...input, categoria: input.categoria ?? "Infração" }, opts);
}

export function sincronizarClienteDespesa(
  veiculoIdRaw: string,
  input: ClienteDespesaInput,
  opts?: { prazoDias?: number; fonteDetran?: string },
): SincronizarClienteDespesaResult {
  const db = loadClienteDespesasDb();
  const veiculoId = formatPlacaHyphen(veiculoIdRaw);
  const autoKey = String(input.autoInfracao).trim().toUpperCase();
  const categoria = input.categoria?.trim() || "Infração";
  const idx = db.clienteDespesas.findIndex(
    (m) => m.autoInfracao.trim().toUpperCase() === autoKey,
  );

  if (idx < 0) {
    const r = gravarClienteDespesa(veiculoId, { ...input, categoria }, { prazoDias: opts?.prazoDias });
    return { registro: r.registro, aviso: r.aviso, acao: "novo" };
  }

  const m = db.clienteDespesas[idx]!;
  // Estado desejado da marca de revisão (categorias que inferem condutor sem data).
  const inferCond = categoriaInfereCondutor(categoria);
  const dataFinal = String((input.dataAutuacao || m.dataAutuacao) || "").trim();
  const quitadaFinal =
    input.quitadaDetran === true ||
    (input.quitadaDetran !== false && m.quitadaDetran === true);
  // Quitada no DETRAN não é cobrável → não precisa data, condutor nem revisão.
  const desejaRevisar = inferCond && !dataFinal && !quitadaFinal;
  const desejaConfirmar = quitadaFinal && !m.condutorConfirmado;
  const flagRevisarMudou = !!m.revisarManual !== desejaRevisar;

  // Título curto (Gastos Gerais) das infrações: derivado de descricao + data.
  const descricaoFinal = String(input.descricao ?? m.descricao ?? "").trim();
  const desejaTitulo = isCategoriaInfracao(categoria)
    ? input.titulo?.trim() || tituloInfracaoBase(descricaoFinal, dataFinal)
    : null;
  const tituloMudou = desejaTitulo !== null && (m.titulo ?? "") !== desejaTitulo;

  if (
    !registroChanged(m, { ...input, categoria }) &&
    !flagRevisarMudou &&
    !desejaConfirmar &&
    !tituloMudou
  ) {
    return { registro: m, aviso: null, acao: "sem_alteracao" };
  }

  m.categoria = categoria;
  m.situacao = String(input.situacao).trim();
  m.valorMulta = parseValor(input.valorMulta);
  m.limiteDefesa = String(input.limiteDefesa).trim();
  m.descricao = String(input.descricao).trim();
  if (desejaTitulo !== null) m.titulo = desejaTitulo;
  if (input.localInfracao) m.localInfracao = String(input.localInfracao).trim();
  if (input.dataAutuacao) m.dataAutuacao = String(input.dataAutuacao).trim();
  if (input.quitadaDetran === true) m.quitadaDetran = true;
  if (input.quitadaDetran === false) m.quitadaDetran = false;
  m.origem = input.origem ?? m.origem;
  m.atualizadoEm = nowIso();

  // Quitada → marca confirmado (nada a cobrar/vincular); senão resolve por vigência.
  if (quitadaFinal) {
    if (!m.condutorConfirmado) m.condutorConfirmado = true;
    if (m.condutorNaoIdentificado) m.condutorNaoIdentificado = false;
  } else if (!m.condutorConfirmado && !m.condutorId && dataFinal && inferCond) {
    if (parseDataAutuacao(dataFinal)) {
      const res = resolverCondutorVigencia(veiculoId, dataFinal, opts?.prazoDias ?? 90);
      m.condutorId = res.condutorId;
      m.condutorContrato = res.condutorContrato;
      if (res.condutorConfirmado) m.condutorConfirmado = true;
      if (res.naoIdentificado) m.condutorNaoIdentificado = true;
    }
  }

  // Sem data de autuação (categoria que infere condutor) → revisar manualmente;
  // se a data passou a existir, limpa a marca.
  if (inferCond) {
    if (desejaRevisar) {
      m.revisarManual = true;
      m.revisarMotivo = "Sem data de autuação no DETRAN — revisar manualmente";
    } else if (m.revisarManual) {
      m.revisarManual = false;
      m.revisarMotivo = null;
    }
  }

  db.clienteDespesas[idx] = m;
  saveClienteDespesasDb(db);
  return {
    registro: m,
    aviso: opts?.fonteDetran ? `sync ${opts.fonteDetran}` : null,
    acao: "atualizado",
  };
}

/** @deprecated use sincronizarClienteDespesa */
export function sincronizarInfracao(
  veiculoIdRaw: string,
  input: ClienteDespesaInput,
  opts?: { prazoDias?: number; fonteDetran?: string },
): SincronizarClienteDespesaResult {
  return sincronizarClienteDespesa(
    veiculoIdRaw,
    { ...input, categoria: input.categoria ?? "Infração" },
    opts,
  );
}

export function confirmarCondutorClienteDespesa(
  autoInfracao: string,
  condutorId?: string | null,
): ClienteDespesaRegistro | null {
  const db = loadClienteDespesasDb();
  const key = autoInfracao.trim().toUpperCase();
  const idx = db.clienteDespesas.findIndex((m) => m.autoInfracao.trim().toUpperCase() === key);
  if (idx < 0) return null;

  const m = db.clienteDespesas[idx]!;
  if (condutorId !== undefined) m.condutorId = condutorId;
  m.condutorConfirmado = true;
  m.atualizadoEm = nowIso();
  db.clienteDespesas[idx] = m;
  saveClienteDespesasDb(db);
  return m;
}

/** @deprecated use confirmarCondutorClienteDespesa */
export function confirmarCondutorInfracao(
  autoInfracao: string,
  condutorId?: string | null,
): ClienteDespesaRegistro | null {
  return confirmarCondutorClienteDespesa(autoInfracao, condutorId);
}

export function isInfracaoTransito(r: ClienteDespesaRegistro): boolean {
  return (r.categoria ?? "Infração") === "Infração";
}

export function autoInfracaoRastreame(rastreameId: string | number): string {
  return `RAST-${rastreameId}`;
}

export function parseRastreameIdFromAuto(autoInfracao: string): string | null {
  const m = String(autoInfracao).trim().match(/^RAST-(\d+)$/i);
  return m ? m[1]! : null;
}

export function isClienteDespesaAtiva(r: ClienteDespesaRegistro): boolean {
  return r.ativo !== false;
}

/** Débito espelhado ou elegível para Gastos Gerais no Rastreame. */
export function isSyncRastreameEligible(r: ClienteDespesaRegistro): boolean {
  if (!isClienteDespesaAtiva(r)) return false;
  if (r.rastreameId != null && r.rastreameId !== "") return true;
  if (r.origem === "rastreame") return true;
  const cat = r.categoria ?? "Infração";
  if (cat === "Infração") return false;
  return CATEGORIAS_SYNC_RASTREAME.has(cat);
}

export function findClienteDespesaByRastreameId(
  rastreameId: string | number,
): ClienteDespesaRegistro | null {
  const key = String(rastreameId);
  const db = loadClienteDespesasDb();
  return (
    db.clienteDespesas.find(
      (m) => m.rastreameId != null && String(m.rastreameId) === key,
    ) ?? null
  );
}

export function findClienteDespesaById(id: string): ClienteDespesaRegistro | null {
  const db = loadClienteDespesasDb();
  return db.clienteDespesas.find((m) => m.id === id) ?? null;
}

export type ClienteDespesaPatch = Partial<
  Pick<
    ClienteDespesaRegistro,
    | "categoria"
    | "descricao"
    | "titulo"
    | "localInfracao"
    | "dataAutuacao"
    | "valorMulta"
    | "situacao"
    | "limiteDefesa"
    | "condutorId"
    | "condutorConfirmado"
    | "condutorNaoIdentificado"
    | "paga"
    | "pagaEm"
    | "rastreameMotoristaKey"
    | "rastreameRastreavelKey"
    | "rastreameDataIso"
    | "ativo"
  >
>;

export function editarClienteDespesa(
  idOrAuto: string,
  patch: ClienteDespesaPatch,
): ClienteDespesaRegistro | null {
  const db = loadClienteDespesasDb();
  const key = idOrAuto.trim();
  const idx = db.clienteDespesas.findIndex(
    (m) =>
      m.id === key ||
      m.autoInfracao.trim().toUpperCase() === key.toUpperCase(),
  );
  if (idx < 0) return null;

  const m = db.clienteDespesas[idx]!;
  if (patch.categoria !== undefined) m.categoria = patch.categoria;
  if (patch.descricao !== undefined) m.descricao = String(patch.descricao).trim();
  if (patch.titulo !== undefined) m.titulo = String(patch.titulo).trim();
  if (patch.localInfracao !== undefined) m.localInfracao = String(patch.localInfracao).trim();
  if (patch.dataAutuacao !== undefined) m.dataAutuacao = String(patch.dataAutuacao).trim();
  if (patch.valorMulta !== undefined) m.valorMulta = parseValor(patch.valorMulta);
  if (patch.situacao !== undefined) m.situacao = String(patch.situacao).trim();
  if (patch.limiteDefesa !== undefined) m.limiteDefesa = String(patch.limiteDefesa).trim();
  if (patch.condutorId !== undefined) m.condutorId = patch.condutorId;
  if (patch.condutorConfirmado !== undefined) m.condutorConfirmado = patch.condutorConfirmado;
  if (patch.condutorNaoIdentificado !== undefined) {
    m.condutorNaoIdentificado = patch.condutorNaoIdentificado;
  }
  if (patch.paga !== undefined) m.paga = patch.paga;
  if (patch.pagaEm !== undefined) m.pagaEm = patch.pagaEm;
  if (patch.rastreameMotoristaKey !== undefined) {
    m.rastreameMotoristaKey = patch.rastreameMotoristaKey;
  }
  if (patch.rastreameRastreavelKey !== undefined) {
    m.rastreameRastreavelKey = patch.rastreameRastreavelKey;
  }
  if (patch.rastreameDataIso !== undefined) m.rastreameDataIso = patch.rastreameDataIso;
  if (patch.ativo !== undefined) m.ativo = patch.ativo;
  m.atualizadoEm = nowIso();
  db.clienteDespesas[idx] = m;
  saveClienteDespesasDb(db);
  return m;
}

export function excluirClienteDespesa(idOrAuto: string): ClienteDespesaRegistro | null {
  return editarClienteDespesa(idOrAuto, { ativo: false });
}

export type UpsertRecebimentoRastreameInput = {
  rastreameId: string | number;
  veiculoId: string;
  categoria: string;
  descricao: string;
  titulo?: string;
  dataAutuacao: string;
  valorMulta: number;
  situacao: string;
  paga?: boolean;
  pagaEm?: string | null;
  condutorId?: string | null;
  rastreameMotoristaKey?: string | null;
  rastreameRastreavelKey?: string | null;
  rastreameDataIso?: string | null;
  rastreameTipo?: string | null;
  force?: boolean;
};

export function upsertRecebimentoFromRastreame(
  input: UpsertRecebimentoRastreameInput,
): SincronizarClienteDespesaResult {
  const db = loadClienteDespesasDb();
  const veiculoId = formatPlacaHyphen(input.veiculoId);
  const rid = String(input.rastreameId);
  const autoKey = autoInfracaoRastreame(rid);
  const ts = nowIso();

  const idxByRastreame = db.clienteDespesas.findIndex(
    (m) => m.rastreameId != null && String(m.rastreameId) === rid,
  );
  const idxByAuto = db.clienteDespesas.findIndex(
    (m) => m.autoInfracao.trim().toUpperCase() === autoKey.toUpperCase(),
  );
  const idx = idxByRastreame >= 0 ? idxByRastreame : idxByAuto;

  const isInfra = isCategoriaInfracao(input.categoria);

  if (idx < 0) {
    const registro: ClienteDespesaRegistro = {
      id: crypto.randomUUID(),
      categoria: input.categoria,
      veiculoId,
      autoInfracao: autoKey,
      descricao: input.descricao,
      titulo: isInfra
        ? input.titulo?.trim() || tituloInfracaoBase(input.descricao, input.dataAutuacao)
        : input.titulo?.trim() || undefined,
      localInfracao: "",
      dataAutuacao: input.dataAutuacao,
      valorMulta: input.valorMulta,
      situacao: input.situacao,
      limiteDefesa: "",
      condutorId: input.condutorId ?? null,
      condutorConfirmado: false,
      condutorContrato: null,
      paga: input.paga,
      pagaEm: input.pagaEm ?? null,
      rastreameId: input.rastreameId,
      rastreameMotoristaKey: input.rastreameMotoristaKey ?? null,
      rastreameRastreavelKey: input.rastreameRastreavelKey ?? null,
      rastreameDataIso: input.rastreameDataIso ?? null,
      rastreameTipo: input.rastreameTipo ?? null,
      rastreameSyncEm: ts,
      ativo: true,
      cadastradoEm: ts,
      atualizadoEm: ts,
      origem: "rastreame",
    };
    db.clienteDespesas.push(registro);
    saveClienteDespesasDb(db);
    return { registro, aviso: null, acao: "novo" };
  }

  const m = db.clienteDespesas[idx]!;
  if (
    !input.force &&
    m.rastreameSyncEm &&
    m.atualizadoEm > m.rastreameSyncEm
  ) {
    return { registro: m, aviso: "local mais recente — pull ignorado", acao: "sem_alteracao" };
  }

  // Infração: o Rastreame guarda o título (não o texto do DETRAN) → atualiza `titulo`,
  // preservando a `descricao` (texto cru do DETRAN, fonte: sync-infracoes).
  const tituloInput = isInfra ? input.titulo?.trim() || stripAtrasado(input.descricao) : undefined;
  const changed =
    (isInfra ? (m.titulo ?? "") !== (tituloInput ?? "") : m.descricao !== input.descricao) ||
    m.valorMulta !== input.valorMulta ||
    m.situacao !== input.situacao ||
    m.dataAutuacao !== input.dataAutuacao ||
    m.paga !== input.paga ||
    m.categoria !== input.categoria ||
    m.veiculoId !== veiculoId;

  m.categoria = input.categoria;
  m.veiculoId = veiculoId;
  if (isInfra) {
    if (tituloInput) m.titulo = tituloInput;
    if (!m.descricao?.trim()) m.descricao = input.descricao;
  } else {
    m.descricao = input.descricao;
  }
  m.valorMulta = input.valorMulta;
  m.situacao = input.situacao;
  m.dataAutuacao = input.dataAutuacao;
  if (input.paga !== undefined) m.paga = input.paga;
  if (input.pagaEm !== undefined) m.pagaEm = input.pagaEm;
  if (input.condutorId !== undefined && !m.condutorConfirmado) m.condutorId = input.condutorId;
  m.rastreameId = input.rastreameId;
  m.rastreameMotoristaKey = input.rastreameMotoristaKey ?? m.rastreameMotoristaKey ?? null;
  m.rastreameRastreavelKey = input.rastreameRastreavelKey ?? m.rastreameRastreavelKey ?? null;
  m.rastreameDataIso = input.rastreameDataIso ?? m.rastreameDataIso ?? null;
  m.rastreameTipo = input.rastreameTipo ?? m.rastreameTipo ?? null;
  m.rastreameSyncEm = ts;
  m.ativo = true;
  m.origem = m.origem === "manual" ? m.origem : "rastreame";
  m.atualizadoEm = ts;
  db.clienteDespesas[idx] = m;
  saveClienteDespesasDb(db);
  return {
    registro: m,
    aviso: null,
    acao: changed ? "atualizado" : "sem_alteracao",
  };
}

export function marcarRastreameSyncOk(
  idOrAuto: string,
  rastreameId?: string | number,
): ClienteDespesaRegistro | null {
  const db = loadClienteDespesasDb();
  const key = idOrAuto.trim();
  const idx = db.clienteDespesas.findIndex(
    (m) =>
      m.id === key ||
      m.autoInfracao.trim().toUpperCase() === key.toUpperCase(),
  );
  if (idx < 0) return null;
  const m = db.clienteDespesas[idx]!;
  if (rastreameId != null) m.rastreameId = rastreameId;
  m.rastreameSyncEm = nowIso();
  db.clienteDespesas[idx] = m;
  saveClienteDespesasDb(db);
  return m;
}
