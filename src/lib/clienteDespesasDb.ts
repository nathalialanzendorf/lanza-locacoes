import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { jsonDocumentExists, loadJsonDocument, loadJsonDocumentForApi, saveJsonDocument, saveJsonDocumentAsync, useRelationalStore, assertRelationalStore, loadClienteDespesasFromSql, queryClienteDespesasFromSql, queryClienteDespesaByReferenciaFromSql, deleteClienteDespesaFromSql, upsertClienteDespesaRowToSql, updateClienteDespesaRowToSql, saveClienteDespesasToSql, type ClienteDespesasSqlFilter, type PersistClienteDespesaSqlOpts } from "@lanza/db";
import { pagaEmInputToIso } from "./dataBr.js";
import { getCobrancasRuntimeCtx } from "./cobrancasDbContext.js";
import { inferirCondutorInfracao, parseDataAutuacao } from "./inferirCondutorInfracao.js";
import {
  isCategoriaInfracao,
  pareceDescricaoInfracaoCobranca,
  stripAtrasado,
  normalizarCamposInfracaoCliente,
  descricaoInfracaoCliente,
  repararCamposInfracaoCliente,
} from "./infracaoTitulo.js";
import {
  dataVencimentoSemanalBr,
  formatDataBr,
  isPagamentoSemanalDescricao,
  normalizarBaixaSemanal,
  proximaParcelaSemanal,
  stripAtrasadoSemanal,
} from "./pagamentoSemanal.js";
import { compactPlaca, formatPlacaHyphen } from "./placa.js";
import { isEntityUuid, resolveVeiculoIdListagem } from "./filtroListagem.js";
import { findVeiculoInDb, loadVeiculosDb, loadVeiculosDbAsync, type VeiculoRegistro } from "./veiculosDb.js";
import { loadContratosDb, contratoMaisRecentePar, type ContratoRegistro } from "./contratosDb.js";
import { CATEGORIA_PEDAGIO } from "./despesaCategorias.js";
import {
  CategoriaDespesaCliente,
  CATEGORIAS_SYNC_RASTREAME,
} from "./domain/categoriaDespesaCliente.js";
import { StatusContrato } from "./domain/statusContrato.js";

export { CATEGORIAS_SYNC_RASTREAME };
import { isCategoriaPedagio } from "./pedagioCategoria.js";
import { isCategoriaEstacionamento } from "./estacionamentoCategoria.js";
import { atualizarPdfArquivoInfracaoDb } from "./infracoesDb.js";
import { espelharClienteDespesaSemLocatario, espelharClienteDespesaSemLocatarioAsync, origemParceiroPedagioSemLocatario } from "./espelharSemLocatarioParceiro.js";
import { removerParceiroDespesaPorOrigem, removerParceiroDespesaPorOrigemAsync } from "./parceiroDespesasDb.js";
import { despesaResponsavelConfirmado, parceiroDebitoConfirmado } from "./responsavelDebito.js";
import { REPO_ROOT } from "./repoRoot.js";

export const DB_CLIENTE_DESPESAS = path.join(
  REPO_ROOT,
  "database",
  "cliente-despesas.json",
);
const DB_INFRACOES_LEGACY = path.join(REPO_ROOT, "database", "infracoes.json");
const DB_MULTAS_LEGACY = path.join(REPO_ROOT, "database", "multas.json");

/**
 * Categorias cujo condutor é inferido pelo contrato ativo na data
 * (mesmo vínculo das infrações: placa + dataAutuacao com hora).
 */
export function categoriaInfereCondutor(categoria: string | undefined | null): boolean {
  const c = (categoria ?? CategoriaDespesaCliente.Infracao).trim();
  return c === CategoriaDespesaCliente.Infracao || isCategoriaPedagio(c) || isCategoriaEstacionamento(c);
}

/** Manutenção cobrável do locatário (lavação entra aqui; categoria legada "Lavação" ainda aceita). */
export function isCategoriaManutencao(categoria: string | undefined | null): boolean {
  const c = (categoria ?? "").trim();
  return c === CategoriaDespesaCliente.Manutencao || c === CategoriaDespesaCliente.Lavacao;
}

export type ClienteDespesaRegistro = {
  id: string;
  categoria?: string;
  veiculoId: string;
  autoInfracao: string;
  /** Texto cru do DETRAN (ex.: "TRANSITAR EM VEL SUPERIOR À MÁXIMA…"). */
  titulo?: string;
  /** Rótulo de cobrança (ex.: "Pagamento infração velocidade - 30/03/2026 09:40"). */
  descricao: string;
  /** Número do auto DETRAN — igual a `autoInfracao`; vínculo autuação ↔ débito. */
  numeroAuto?: string;
  localInfracao: string;
  dataAutuacao: string;
  valorMulta: number;
  /**
   * Status externo ou descritivo (DETRAN, pedágio, estacionamento, etc.).
   * Não indica recebimento na conta Lanza — use `paga` para isso.
   */
  situacao: string;
  /** Espelho legado: autuação → dataLimiteDefesa; débito → dataVencimentoOriginal. */
  limiteDefesa: string;
  /** Prazo de defesa da autuação (DD/MM/AAAA), bloco `infracoes` do DETRAN. */
  dataLimiteDefesa?: string;
  /** Vencimento original do boleto (DD/MM/AAAA) — base de juros/multa após conversão. */
  dataVencimentoOriginal?: string;
  /** true quando a infração virou débito (bloco `debitos` ou defesa vencida). */
  convertidaEmDebito?: boolean;
  condutorId: string | null;
  condutorConfirmado: boolean;
  condutorContrato: string | null;
  /** true = sem contrato/locatário na data da autuação — débito vai a parceiro-despesas, não cliente. */
  condutorNaoIdentificado?: boolean;
  /** Operador confirmou: débito do parceiro/dono (não cobrar locatário). */
  debitoParceiroConfirmado?: boolean;
  /** Parceiro confirmado manualmente (uuid → parceiros.json). */
  debitoParceiroId?: string | null;
  /** true = precisa revisão manual (ex.: infração sem data de autuação no DETRAN). */
  revisarManual?: boolean;
  /** Motivo da revisão manual (texto curto). */
  revisarMotivo?: string | null;
  /** true = dinheiro recebido na conta Lanza (baixa/recebimento registrado). */
  paga?: boolean;
  /**
   * Status de cobrança Lanza: em_aberto | pago | baixado.
   * `baixado` = quitado sem caixa (ex.: descontado do caução no encerramento).
   * Preferir este campo; `paga` permanece sincronizado (pago ↔ paga=true).
   */
  statusCobranca?: "em_aberto" | "pago" | "baixado";
  /** Data/hora ISO do recebimento na Lanza. */
  pagaEm?: string | null;
  quitadaDetran?: boolean;
  /** Status bruto do DETRAN: Advertida | Paga | Notificada | Justificada. */
  statusInfracao?: string;
  /**
   * Status semântico (minúsculas) para regras de cobrança: advertida | paga | justificada.
   * Ausente em Notificada (cobrável).
   */
  statusDetran?: string;
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
  /**
   * Auto DETRAN ligado ao gasto Rastreame (campo `comprovante` no site).
   * Ex.: RAST-408 → J008087450.
   */
  detranAutoInfracao?: string | null;
  /** Caminho do PDF da notificação/auto (absoluto ou relativo a documentosRaiz). */
  pdfArquivo?: string | null;
  /** false = excluída (soft delete interno); não é status operacional de cobrança. */
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
  dataLimiteDefesa?: string;
  dataVencimentoOriginal?: string;
  convertidaEmDebito?: boolean;
  numeroAuto?: string;
  categoria?: string;
  origem?: string;
  quitadaDetran?: boolean;
  /** Status bruto do DETRAN: Advertida | Paga | Notificada | Justificada. */
  statusInfracao?: string;
  /**
   * Status semântico (minúsculas) para regras de cobrança: advertida | paga | justificada.
   * Ausente em Notificada (cobrável).
   */
  statusDetran?: string;
  paga?: boolean;
  /** em_aberto | pago | baixado — preferir sobre `paga` ao gravar. */
  statusCobranca?: "em_aberto" | "pago" | "baixado";
  pagaEm?: string | null;
  rastreameId?: string | number | null;
  rastreameMotoristaKey?: string | null;
  rastreameRastreavelKey?: string | null;
  rastreameDataIso?: string | null;
  rastreameTipo?: string | null;
  /** Locatário responsável — quando informado, não depende de inferência/contrato ativo. */
  condutorId?: string | null;
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
  "Débitos a cobrar dos locatários/clientes: infrações, locação, caução, manutenção (incl. lavação), quebra de contrato, estacionamento, pedágio, etc.";

const DEFAULT_SCHEMA: Record<string, string> = {
  id: "uuid",
  categoria:
    "Infração | Locação semanal | Caução | Manutenção | Quebra contrato | Renegociação | Estacionamento | Pedágio | Outros",
  veiculoId: "uuid → veiculos (FK obrigatório)",
  autoInfracao: "Chave natural (auto DETRAN ou id interno)",
  descricao: "Descrição do débito",
  localInfracao: "Local (infrações) ou vazio",
  dataAutuacao: "DD/MM/AAAA HH:mm ou data do débito",
  valorMulta: "Valor em reais",
  situacao: "Situação (DETRAN ou controle interno)",
  limiteDefesa: "Espelho legado — autuação: dataLimiteDefesa; débito: dataVencimentoOriginal",
  dataLimiteDefesa: "Prazo de defesa da autuação (DD/MM/AAAA) — bloco infracoes",
  dataVencimentoOriginal: "Vencimento original do boleto (DD/MM/AAAA) — juros/multa após esta data",
  convertidaEmDebito: "boolean — infração convertida em débito (debitos[] ou defesa vencida)",
  numeroAuto: "Número do auto DETRAN (= autoInfracao) — vínculo com infracoes.json",
  condutorId: "uuid -> clientes.json (null se não identificado)",
  condutorConfirmado: "false no cadastro; true após confirmação do usuário ou inferência por vigência",
  condutorContrato: "Pasta do contrato usado na sugestão de condutor",
  condutorNaoIdentificado: "boolean — sem locatário na autuação (espelho em parceiro-despesas, não cliente)",
  revisarManual: "boolean — true se precisa revisão manual (ex.: infração sem data de autuação)",
  revisarMotivo: "Motivo curto da revisão manual",
  paga: "boolean — quitada em caixa (sincronizado com statusCobranca=pago)",
  statusCobranca: "em_aberto | pago | baixado (baixado = ex. descontado do caução)",
  pagaEm: "DD/MM/AAAA — quando foi paga (opcional)",
  quitadaDetran: "boolean — quitada no DETRAN (só infrações); não cobrar locatário",
  statusInfracao: "string — status DETRAN: Advertida | Paga | Notificada | Justificada",
  statusDetran: "string — status semântico: advertida | paga | justificada | (ausente em Notificada)",
  cadastradoEm: "ISO 8601",
  atualizadoEm: "ISO 8601",
  origem: "manual | portal | detran-sc | rastreame | ...",
  rastreameId: "id numérico em rastreame.com.br (Gastos Gerais)",
  rastreameMotoristaKey: "motorista.key no Rastreame",
  rastreameRastreavelKey: "rastreavel.key no Rastreame",
  rastreameDataIso: "data ISO do gasto no Rastreame",
  rastreameTipo: "tipo do gasto no Rastreame (OUTROS, DOCUMENTACAO, ...)",
  rastreameSyncEm: "ISO 8601 — última sync com Rastreame",
  detranAutoInfracao: "Auto DETRAN (campo comprovante do Rastreame; ex. J008087450)",
  pdfArquivo: "Caminho do PDF da infração (pasta Débitos do contrato ou veículo)",
  ativo: "legado — exclusão remove o registro; listagem oculta ativo=false antigos",
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

function parseValorSafe(v: unknown): number {
  if (v == null || v === "") return 0;
  try {
    return parseValor(v as number | string);
  } catch {
    return 0;
  }
}

/**
 * Histórico DETRAN quitado sem data — não cadastrar local/Rastreame;
 * se o auto já existir, só marcar quitadaDetran (baixa) preservando campos preenchidos.
 * Valor irrelevante (com ou sem valor no payload DETRAN).
 */
export function isQuitadaDetranSemData(input: {
  quitadaDetran?: boolean;
  dataAutuacao?: string | null;
}): boolean {
  if (input.quitadaDetran !== true) return false;
  const data = String(input.dataAutuacao ?? "").trim();
  return !data || !parseDataAutuacao(data);
}

/** @deprecated use isQuitadaDetranSemData */
export function isQuitadaDetranSemDados(input: {
  quitadaDetran?: boolean;
  dataAutuacao?: string | null;
  valorMulta?: unknown;
}): boolean {
  return isQuitadaDetranSemData(input);
}

/** Baixa quitada DETRAN em registro existente — não sobrescreve valor, data, descrição etc. */
export function aplicarBaixaQuitadaDetranSomente(
  m: ClienteDespesaRegistro,
  input?: Pick<ClienteDespesaInput, "situacao">,
): boolean {
  let mudou = false;
  if (m.quitadaDetran !== true) {
    m.quitadaDetran = true;
    mudou = true;
  }
  if (!m.condutorConfirmado) {
    m.condutorConfirmado = true;
    mudou = true;
  }
  if (m.condutorId) {
    if (m.condutorNaoIdentificado) {
      m.condutorNaoIdentificado = false;
      mudou = true;
    }
  } else if (!m.condutorNaoIdentificado) {
    m.condutorNaoIdentificado = true;
    mudou = true;
  }
  if (m.revisarManual) {
    m.revisarManual = false;
    m.revisarMotivo = null;
    mudou = true;
  }
  const sitIn = String(input?.situacao ?? "").trim();
  if (sitIn && m.situacao !== sitIn) {
    m.situacao = sitIn;
    mudou = true;
  } else if (!String(m.situacao ?? "").trim()) {
    m.situacao = "QUITADA DETRAN";
    mudou = true;
  }
  return mudou;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeRawDb(raw: Record<string, unknown>): ClienteDespesasDb {
  const rawList = (raw.clienteDespesas ?? raw.infracoes ?? raw.multas ?? []) as ClienteDespesaRegistro[];
  const clienteDespesas = rawList.map((r) => ({
    ...r,
    categoria: r.categoria ?? CategoriaDespesaCliente.Infracao,
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

function isNewInfracoesDbFormat(raw: Record<string, unknown>): boolean {
  const schema = raw.schemaInfracao as Record<string, string> | undefined;
  if (schema?.numeroAuto?.toLowerCase().includes("chave natural")) return true;
  const list = (raw.infracoes ?? []) as Record<string, unknown>[];
  if (list.length === 0) return !!schema?.numeroAuto;
  const first = list[0];
  return !first?.categoria && !!first?.numeroAuto;
}

function migrateLegacyIfNeeded(): void {
  if (!fs.existsSync(DB_CLIENTE_DESPESAS)) {
    if (fs.existsSync(DB_INFRACOES_LEGACY)) {
      const raw = JSON.parse(fs.readFileSync(DB_INFRACOES_LEGACY, "utf8")) as Record<
        string,
        unknown
      >;
      if (!isNewInfracoesDbFormat(raw)) {
        migrateLegacyFile(DB_INFRACOES_LEGACY, DB_INFRACOES_LEGACY);
        return;
      }
    }
    if (fs.existsSync(DB_MULTAS_LEGACY)) {
      migrateLegacyFile(DB_MULTAS_LEGACY, DB_MULTAS_LEGACY);
    }
  }
}

export function loadClienteDespesasDb(): ClienteDespesasDb {
  migrateLegacyIfNeeded();
  if (!jsonDocumentExists(DB_CLIENTE_DESPESAS)) {
    return {
      descricao: DEFAULT_DESCRICAO,
      atualizadoEm: new Date().toISOString().slice(0, 10),
      schemaClienteDespesa: DEFAULT_SCHEMA,
      clienteDespesas: [],
    };
  }
  const raw = loadJsonDocument<Record<string, unknown>>(DB_CLIENTE_DESPESAS);
  return normalizeRawDb(raw);
}

export type ClienteDespesasLoadScope = ClienteDespesasSqlFilter & {
  id?: string;
  referencia?: string;
};

function hasDespesasScope(scope?: ClienteDespesasLoadScope): boolean {
  if (!scope) return false;
  return Boolean(
    scope.id?.trim() ||
      scope.referencia?.trim() ||
      scope.clienteId?.trim() ||
      scope.veiculoId?.trim() ||
      scope.emAberto !== undefined ||
      scope.ativo !== undefined,
  );
}

export async function loadClienteDespesasDbAsync(
  scope?: ClienteDespesasLoadScope,
): Promise<ClienteDespesasDb> {
  if (await useRelationalStore()) {
    if (hasDespesasScope(scope)) {
      const ref = scope!.id?.trim() || scope!.referencia?.trim();
      const rows = ref
        ? await (async () => {
            const row = await queryClienteDespesaByReferenciaFromSql(ref);
            return row ? [row] : [];
          })()
        : await queryClienteDespesasFromSql({
            clienteId: scope!.clienteId,
            veiculoId: scope!.veiculoId,
            emAberto: scope!.emAberto,
            ativo: scope!.ativo,
          });
      return normalizeRawDb({
        descricao: DEFAULT_DESCRICAO,
        atualizadoEm: new Date().toISOString().slice(0, 10),
        schemaClienteDespesa: DEFAULT_SCHEMA,
        clienteDespesas: rows,
      } as Record<string, unknown>);
    }
    return normalizeRawDb(await loadClienteDespesasFromSql());
  }
  const raw = await loadJsonDocumentForApi<Record<string, unknown>>(DB_CLIENTE_DESPESAS, {
    descricao: DEFAULT_DESCRICAO,
    atualizadoEm: new Date().toISOString().slice(0, 10),
    schemaClienteDespesa: DEFAULT_SCHEMA,
    clienteDespesas: [],
  });
  return normalizeRawDb(raw);
}

export function saveClienteDespesasDb(db: ClienteDespesasDb): void {
  db.atualizadoEm = new Date().toISOString().slice(0, 10);
  if (!db.descricao) db.descricao = DEFAULT_DESCRICAO;
  saveJsonDocument(DB_CLIENTE_DESPESAS, db, { description: DEFAULT_DESCRICAO });
}

async function loadDespesasMut(): Promise<ClienteDespesasDb> {
  return loadClienteDespesasDbAsync();
}

/** Carrega uma despesa por id ou auto (sem catálogo inteiro no Postgres). */
export async function findClienteDespesaByReferenciaAsync(
  idOrAuto: string,
): Promise<ClienteDespesaRegistro | null> {
  const key = idOrAuto.trim();
  if (await useRelationalStore()) {
    const row = await queryClienteDespesaByReferenciaFromSql(key);
    return row ? (row as ClienteDespesaRegistro) : null;
  }
  const db = loadClienteDespesasDb();
  const ku = key.toUpperCase();
  return (
    db.clienteDespesas.find((m) => m.id === key) ??
    db.clienteDespesas.find((m) => m.autoInfracao.trim().toUpperCase() === ku) ??
    null
  );
}

/** Grava só as linhas informadas no Postgres; no JSON persiste o arquivo inteiro. */
async function persistClienteDespesasRowsAsync(
  rows: ClienteDespesaRegistro[],
  jsonDb?: ClienteDespesasDb,
): Promise<void> {
  if (rows.length === 0) return;
  if (await useRelationalStore()) {
    for (const r of rows) {
      await upsertClienteDespesaRowToSql(
        r as unknown as Record<string, unknown>,
        persistOptsClienteDespesa(r),
      );
    }
    return;
  }
  if (jsonDb) await saveClienteDespesasDbAsync(jsonDb);
}

async function saveDespesasMut(
  db: ClienteDespesasDb,
  changed?: ClienteDespesaRegistro[],
): Promise<void> {
  if (await useRelationalStore() && changed?.length) {
    await persistClienteDespesasRowsAsync(changed);
    return;
  }
  await saveClienteDespesasDbAsync(db);
}

export async function findClienteDespesaByIdAsync(id: string): Promise<ClienteDespesaRegistro | null> {
  if (await useRelationalStore()) {
    const row = await queryClienteDespesaByReferenciaFromSql(id.trim());
    return row ? (row as ClienteDespesaRegistro) : null;
  }
  const db = await loadClienteDespesasDbAsync();
  return db.clienteDespesas.find((m) => m.id === id) ?? null;
}

export async function saveClienteDespesasDbAsync(db: ClienteDespesasDb): Promise<void> {
  db.atualizadoEm = new Date().toISOString().slice(0, 10);
  if (!db.descricao) db.descricao = DEFAULT_DESCRICAO;
  await assertRelationalStore();
  await saveClienteDespesasToSql(db as unknown as Parameters<typeof saveClienteDespesasToSql>[0]);
}

/** @deprecated use loadInfracoesDb from ./infracoesDb.js (tabela dedicada) */
export function loadInfracoesDbLegacy(): ClienteDespesasDb {
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
  /** Próxima parcela semanal criada automaticamente na baixa. */
  proximaParcela?: ClienteDespesaRegistro | null;
};

export type EditarClienteDespesaResult = {
  registro: ClienteDespesaRegistro;
  proximaParcela: ClienteDespesaRegistro | null;
};

export type SincronizarClienteDespesaResult = {
  registro: ClienteDespesaRegistro;
  aviso: string | null;
  acao: "novo" | "atualizado" | "sem_alteracao" | "ignorado";
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
    (input.dataLimiteDefesa !== undefined &&
      (a.dataLimiteDefesa ?? "") !== String(input.dataLimiteDefesa).trim()) ||
    (input.dataVencimentoOriginal !== undefined &&
      (a.dataVencimentoOriginal ?? "") !== String(input.dataVencimentoOriginal).trim()) ||
    (input.convertidaEmDebito !== undefined &&
      !!a.convertidaEmDebito !== !!input.convertidaEmDebito) ||
    (input.statusInfracao !== undefined && a.statusInfracao !== input.statusInfracao) ||
    a.descricao !== String(input.descricao).trim() ||
    a.localInfracao !== String(input.localInfracao).trim() ||
    (input.dataAutuacao ? a.dataAutuacao !== String(input.dataAutuacao).trim() : false) ||
    (input.quitadaDetran === true && a.quitadaDetran !== true) ||
    (input.quitadaDetran === false && a.quitadaDetran === true) ||
    (input.statusDetran !== undefined && a.statusDetran !== input.statusDetran) ||
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
 * Resolve o condutor de uma infração/pedágio pela **vigência do contrato** e
 * **`database/locacoes.json`** (reserva enquanto o principal está em manutenção):
 * - contrato + cliente encontrados → **sugere** cliente (confirmação manual);
 * - débito na **placa reserva** com `substituiPlaca` → usa o contrato do veículo principal;
 * - **nenhum contrato ativo** na data → **sugere parceiro** (`condutorNaoIdentificado`);
 * - contrato achado mas cliente fora de `clientes.json` → **sugere parceiro** (confirmação manual).
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
      condutorConfirmado: false,
      naoIdentificado: false,
      aviso: sug.aviso,
    };
  }
  if (!sug.condutorContrato) {
    return {
      condutorId: null,
      condutorContrato: null,
      condutorConfirmado: false,
      naoIdentificado: true,
      aviso: sug.aviso,
    };
  }
  return {
    condutorId: null,
    condutorContrato: sug.condutorContrato,
    condutorConfirmado: false,
    naoIdentificado: true,
    aviso: sug.aviso,
  };
}

export type ClienteDespesaPersistOpts = {
  prazoDias?: number;
  skipInferir?: boolean;
  fonteDetran?: string;
  /** Default false — integração Rastreame descontinuada. */
  syncRastreame?: boolean;
  /** UUID do veículo já resolvido (ex.: criação de contrato). */
  veiculoId?: string;
  /** Não consulta auto_infracao existente (criação inicial do contrato). */
  skipDupCheck?: boolean;
  /** Não consulta semanal duplicada (primeira locação). */
  skipDupSemanal?: boolean;
  /** Não cria a próxima parcela semanal automaticamente (plano de baixa já traz a linha). */
  skipProximaParcela?: boolean;
  /** Valor semanal do contrato recém-criado (evita carregar contratos). */
  valorSemanalContrato?: number;
};

async function pushAposPersistir(
  regs: ClienteDespesaRegistro[],
  _opts?: ClienteDespesaPersistOpts,
): Promise<ClienteDespesaRegistro[]> {
  return regs;
}

function resolvePlacaVeiculoCadastro(
  veiculoIdRaw: string,
  veiculos?: VeiculoRegistro[],
): string {
  const catalog = veiculos ?? getCobrancasRuntimeCtx()?.veiculos ?? loadVeiculosDb().veiculos;
  const veiculo = findVeiculoInDb({ veiculos: catalog }, veiculoIdRaw);
  if (veiculo?.placa?.trim()) return formatPlacaHyphen(veiculo.placa);
  return formatPlacaHyphen(veiculoIdRaw);
}

/** Exige UUID do veículo; placa legada é resolvida na gravação. */
function resolveVeiculoIdFromDespesaPatch(
  veiculoIdRaw: string,
  veiculos?: VeiculoRegistro[],
): string {
  const raw = String(veiculoIdRaw).trim();
  if (isEntityUuid(raw)) return raw;
  const catalog = veiculos ?? getCobrancasRuntimeCtx()?.veiculos ?? loadVeiculosDb().veiculos;
  const veiculo = findVeiculoInDb({ veiculos: catalog }, raw);
  if (veiculo?.id?.trim()) return veiculo.id.trim();
  throw new Error(`Veículo não encontrado: ${raw}. Cadastre o veículo antes de vincular a despesa.`);
}

function dataEventoContratoMs(dataBr: string): number | null {
  const d = parseDataAutuacao(dataBr);
  return d ? d.getTime() : null;
}

function contratoFimEventoMs(c: ContratoRegistro): number | null {
  const fimBr = c.dataEncerramento ?? c.dataFimPrevista;
  if (fimBr?.trim()) {
    const fim = parseDataAutuacao(fimBr.includes(":") ? fimBr : `${fimBr.trim()} 23:59`);
    if (fim) return fim.getTime();
  }
  const inicio = parseDataAutuacao(c.dataInicio);
  if (!inicio) return null;
  return inicio.getTime() + (c.prazoDias ?? 90) * 86_400_000;
}

function contratoVigenteNaDataEvento(
  contratos: ContratoRegistro[],
  veiculoId: string,
  placa: string,
  eventoMs: number,
): ContratoRegistro | null {
  const pNorm = compactPlaca(placa);
  const matches = contratos.filter((c) => {
    const sameVeiculo =
      (isEntityUuid(veiculoId) && c.veiculoId === veiculoId) ||
      compactPlaca(c.placa ?? "") === pNorm ||
      compactPlaca(String(c.veiculoId ?? "")) === pNorm;
    if (!sameVeiculo) return false;
    const inicioMs = dataEventoContratoMs(c.dataInicio);
    const fimMs = contratoFimEventoMs(c);
    if (inicioMs == null || fimMs == null) return false;
    return eventoMs >= inicioMs && eventoMs <= fimMs;
  });
  if (!matches.length) return null;
  matches.sort((a, b) => (b.versao ?? 0) - (a.versao ?? 0));
  return matches[0] ?? null;
}

/** Atribuição por contratos SQL — uso explícito (sync/atribuição manual), não em listagens ou baixa. */
export function inferirCondutorIdDespesaPorContratosDb(
  d: ClienteDespesaRegistro,
  contratos: ContratoRegistro[],
  veiculos?: VeiculoRegistro[],
): string | null {
  if (d.condutorId?.trim() && isEntityUuid(d.condutorId.trim())) return d.condutorId.trim();
  if (d.condutorNaoIdentificado === true && d.condutorConfirmado === true) return null;
  const eventoMs = dataEventoContratoMs(String(d.dataAutuacao ?? ""));
  if (eventoMs == null) return null;
  const placa = resolvePlacaVeiculoCadastro(String(d.veiculoId ?? ""), veiculos);
  const veiculoId =
    (isEntityUuid(d.veiculoId) ? d.veiculoId : null) ??
    resolveVeiculoIdListagem({ placa }, veiculos) ??
    "";
  const contrato = contratoVigenteNaDataEvento(contratos, veiculoId, placa, eventoMs);
  return contrato?.clienteId ?? null;
}

export async function gravarClienteDespesa(
  veiculoIdRaw: string,
  input: ClienteDespesaInput,
  opts?: ClienteDespesaPersistOpts,
): Promise<GravarClienteDespesaResult> {
  const relational = await useRelationalStore();
  let veiculoId: string;
  if (opts?.veiculoId?.trim() && isEntityUuid(opts.veiculoId.trim())) {
    veiculoId = opts.veiculoId.trim();
  } else {
    const veiculoScope = isEntityUuid(veiculoIdRaw.trim())
      ? { veiculoId: veiculoIdRaw.trim() }
      : { placa: veiculoIdRaw.trim() };
    const veiculosDb = await loadVeiculosDbAsync(veiculoScope);
    const veiculo = findVeiculoInDb(veiculosDb, veiculoIdRaw);
    if (!veiculo?.id?.trim()) {
      throw new Error(
        `Veículo não encontrado: ${veiculoIdRaw}. Cadastre o veículo antes de lançar a despesa.`,
      );
    }
    veiculoId = veiculo.id.trim();
  }
  const autoKey = String(input.autoInfracao).trim().toUpperCase();
  const categoria = input.categoria?.trim() || CategoriaDespesaCliente.Infracao;

  if (relational && !opts?.skipDupCheck) {
    const dupRel = await findClienteDespesaByReferenciaAsync(autoKey);
    if (dupRel) {
      return { registro: dupRel, aviso: "Auto já cadastrado", duplicado: true };
    }
  }

  const db = relational ? null : await loadDespesasMut();
  if (!relational) {
    const dup = db!.clienteDespesas.find(
      (m) => m.autoInfracao.trim().toUpperCase() === autoKey,
    );
    if (dup) {
      return { registro: dup, aviso: "Auto já cadastrado", duplicado: true };
    }
  }

  if (isQuitadaDetranSemData(input)) {
    throw new Error(
      `Auto ${input.autoInfracao}: quitada DETRAN sem data — não cadastrar (use sincronizarClienteDespesa)`,
    );
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

  if (input.condutorId?.trim()) {
    condutorId = input.condutorId.trim();
    condutorConfirmado = true;
    naoIdentificado = false;
    revisarManual = false;
  }

  const ts = nowIso();
  const situacaoIn = String(input.situacao).trim();
  let tituloIn = input.titulo?.trim();
  let descricaoIn = String(input.descricao).trim();

  if (isCategoriaInfracao(categoria)) {
    const auto = String(input.numeroAuto ?? input.autoInfracao).trim();
    const campos = normalizarCamposInfracaoCliente({
      textoDetran: tituloIn || descricaoIn,
      dataAutuacao: String(input.dataAutuacao).trim(),
      numeroAuto: auto,
      paga: input.paga,
      situacao: situacaoIn,
    });
    tituloIn = campos.titulo;
    descricaoIn = campos.descricao;
  }

  const registro: ClienteDespesaRegistro = {
    id: crypto.randomUUID(),
    categoria,
    veiculoId,
    autoInfracao: String(input.autoInfracao).trim(),
    descricao: descricaoIn,
    localInfracao: String(input.localInfracao).trim(),
    dataAutuacao: String(input.dataAutuacao).trim(),
    valorMulta: parseValor(input.valorMulta),
    situacao: situacaoIn,
    limiteDefesa: String(input.limiteDefesa).trim(),
    condutorId,
    condutorConfirmado,
    condutorContrato,
    cadastradoEm: ts,
    atualizadoEm: ts,
    origem: input.origem ?? "manual",
  };

  if (isCategoriaInfracao(categoria)) {
    const auto = String(input.numeroAuto ?? input.autoInfracao).trim();
    registro.numeroAuto = auto || undefined;
    registro.titulo = tituloIn;
  } else if (tituloIn) {
    registro.titulo = tituloIn;
  }

  if (revisarManual && !quitada) {
    registro.revisarManual = true;
    registro.revisarMotivo = "Sem data de autuação no DETRAN — revisar manualmente";
  }
  if (naoIdentificado) registro.condutorNaoIdentificado = true;
  if (input.quitadaDetran === true) registro.quitadaDetran = true;
  if (input.statusInfracao !== undefined) registro.statusInfracao = input.statusInfracao;
  if (input.statusDetran !== undefined) registro.statusDetran = input.statusDetran;
  if (input.dataLimiteDefesa !== undefined) {
    registro.dataLimiteDefesa = String(input.dataLimiteDefesa).trim();
  }
  if (input.dataVencimentoOriginal !== undefined) {
    registro.dataVencimentoOriginal = String(input.dataVencimentoOriginal).trim();
  }
  if (input.convertidaEmDebito === true) registro.convertidaEmDebito = true;
  if (input.convertidaEmDebito === false) registro.convertidaEmDebito = false;
  if (input.paga === true) registro.paga = true;
  if (input.paga === false) registro.paga = false;
  if (input.pagaEm !== undefined) {
    registro.pagaEm =
      input.pagaEm == null || input.pagaEm === ""
        ? null
        : pagaEmInputToIso(input.pagaEm) ?? String(input.pagaEm).trim();
  }
  sincronizarStatusCobranca(registro, {
    paga: input.paga,
    statusCobranca: input.statusCobranca,
    pagaEm: input.pagaEm,
  });
  if (registro.statusCobranca == null) {
    registro.statusCobranca = registro.paga === true ? "pago" : "em_aberto";
  }
  if (input.rastreameId != null) registro.rastreameId = input.rastreameId;
  if (input.rastreameMotoristaKey != null) {
    registro.rastreameMotoristaKey = input.rastreameMotoristaKey;
  }
  if (input.rastreameRastreavelKey != null) {
    registro.rastreameRastreavelKey = input.rastreameRastreavelKey;
  }
  if (input.rastreameDataIso != null) registro.rastreameDataIso = input.rastreameDataIso;
  if (input.rastreameTipo != null) registro.rastreameTipo = input.rastreameTipo;

  if (relational) {
    let proximaParcela: ClienteDespesaRegistro | null = null;
    if (
      !opts?.skipProximaParcela &&
      input.paga === true &&
      registro.categoria === CategoriaDespesaCliente.LocacaoSemanal &&
      isPagamentoSemanalDescricao(registro.descricao)
    ) {
      const venc =
        dataVencimentoSemanalBr(registro.descricao, registro.rastreameDataIso) ??
        registro.dataAutuacao;
      proximaParcela = await criarProximaParcelaSemanalRelational(
        registro,
        registro.descricao,
        venc,
        opts?.valorSemanalContrato ?? valorParcelaSemanalContrato(veiculoId) ?? undefined,
        opts?.skipDupSemanal,
      );
    }
    await persistClienteDespesasRowsAsync(
      proximaParcela ? [registro, proximaParcela] : [registro],
    );
    const synced = await pushAposPersistir(
      proximaParcela ? [registro, proximaParcela] : [registro],
      opts,
    );
    return {
      registro: synced[0]!,
      aviso,
      duplicado: false,
      proximaParcela: proximaParcela ? synced[1] ?? null : null,
    };
  }

  db!.clienteDespesas.push(registro);

  let proximaParcela: ClienteDespesaRegistro | null = null;
  if (
    !opts?.skipProximaParcela &&
    input.paga === true &&
    registro.categoria === CategoriaDespesaCliente.LocacaoSemanal &&
    isPagamentoSemanalDescricao(registro.descricao)
  ) {
    const venc = vencimentoSemanalParaBaixa(
      registro.descricao,
      veiculoId,
      registro.pagaEm,
      registro.rastreameDataIso,
      db!,
    );
    if (venc) {
      proximaParcela = criarProximaParcelaSemanalSeNecessario(
        registro,
        registro.descricao,
        venc,
        db!,
      );
    }
  }

  await saveDespesasMut(db!, proximaParcela ? [registro, proximaParcela] : [registro]);

  const synced = await pushAposPersistir(
    proximaParcela ? [registro, proximaParcela] : [registro],
    opts,
  );

  return {
    registro: synced[0]!,
    aviso,
    duplicado: false,
    proximaParcela: proximaParcela ? synced[1] ?? null : null,
  };
}

/** @deprecated use gravarClienteDespesa */
export function gravarInfracao(
  veiculoIdRaw: string,
  input: ClienteDespesaInput,
  opts?: ClienteDespesaPersistOpts,
): Promise<GravarClienteDespesaResult> {
  return gravarClienteDespesa(veiculoIdRaw, { ...input, categoria: input.categoria ?? CategoriaDespesaCliente.Infracao }, opts);
}

export async function sincronizarClienteDespesa(
  veiculoIdRaw: string,
  input: ClienteDespesaInput,
  opts?: ClienteDespesaPersistOpts,
): Promise<SincronizarClienteDespesaResult> {
  const relational = await useRelationalStore();
  const db = relational ? await loadClienteDespesasDbAsync() : loadClienteDespesasDb();
  const veiculoId = formatPlacaHyphen(veiculoIdRaw);
  const autoKey = String(input.autoInfracao).trim().toUpperCase();
  const categoria = input.categoria?.trim() || CategoriaDespesaCliente.Infracao;
  const idx = db.clienteDespesas.findIndex(
    (m) => m.autoInfracao.trim().toUpperCase() === autoKey,
  );

  const quitadaSemData = isQuitadaDetranSemData({
    quitadaDetran: input.quitadaDetran,
    dataAutuacao: input.dataAutuacao,
  });

  if (idx < 0) {
    if (quitadaSemData) {
      return {
        registro: {
          id: "",
          categoria,
          veiculoId,
          autoInfracao: String(input.autoInfracao).trim(),
          descricao: String(input.descricao ?? "").trim(),
          localInfracao: "",
          dataAutuacao: "",
          valorMulta: parseValorSafe(input.valorMulta),
          situacao: String(input.situacao ?? "").trim(),
          limiteDefesa: "",
          condutorId: null,
          condutorConfirmado: true,
          condutorContrato: null,
          quitadaDetran: true,
          cadastradoEm: "",
          atualizadoEm: "",
          origem: input.origem ?? "detran-sc",
        },
        aviso: "Quitada DETRAN sem data — auto ausente; não cadastrado",
        acao: "ignorado",
      };
    }
    const dataNova = String(input.dataAutuacao ?? "").trim();
    if (
      isCategoriaInfracao(categoria) &&
      input.quitadaDetran !== true &&
      (!dataNova || !parseDataAutuacao(dataNova))
    ) {
      return {
        registro: {
          id: "",
          categoria,
          veiculoId,
          autoInfracao: String(input.autoInfracao).trim(),
          descricao: String(input.descricao ?? "").trim(),
          localInfracao: "",
          dataAutuacao: dataNova,
          valorMulta: parseValorSafe(input.valorMulta),
          situacao: String(input.situacao ?? "").trim(),
          limiteDefesa: "",
          condutorId: null,
          condutorConfirmado: false,
          condutorContrato: null,
          cadastradoEm: "",
          atualizadoEm: "",
          origem: input.origem ?? "detran-sc",
        },
        aviso: "Sem data de autuação — espelhar em parceiro-despesas (não cliente)",
        acao: "ignorado",
      };
    }
    const r = await gravarClienteDespesa(veiculoId, { ...input, categoria }, opts);
    return { registro: r.registro, aviso: r.aviso, acao: "novo" };
  }

  const m = db.clienteDespesas[idx]!;

  if (quitadaSemData) {
    const mudou = aplicarBaixaQuitadaDetranSomente(m, input);
    if (!mudou) {
      return { registro: m, aviso: null, acao: "sem_alteracao" };
    }
    m.atualizadoEm = nowIso();
    db.clienteDespesas[idx] = m;
    await saveDespesasMut(db, [m]);
    const [synced] = await pushAposPersistir([m], opts);
    return {
      registro: synced ?? m,
      aviso: "Quitada DETRAN — baixa aplicada (campos existentes preservados)",
      acao: "atualizado",
    };
  }
  // Estado desejado da marca de revisão (categorias que inferem condutor sem data).
  const inferCond = categoriaInfereCondutor(categoria);
  const dataFinal = String((input.dataAutuacao || m.dataAutuacao) || "").trim();
  const quitadaFinal =
    input.quitadaDetran === true ||
    (input.quitadaDetran !== false && m.quitadaDetran === true);
  // Quitada no DETRAN não é cobrável → não precisa data, condutor nem revisão.
  const dataValida = !!dataFinal && !!parseDataAutuacao(dataFinal);
  const desejaRevisar = inferCond && !dataValida && !quitadaFinal;
  const desejaConfirmar = quitadaFinal && !m.condutorConfirmado;
  const flagRevisarMudou = !!m.revisarManual !== desejaRevisar;

  // Infração: titulo = DETRAN; descricao = Pagamento infração {tipo} {data}.
  const descricaoDetran = String(input.descricao ?? "").trim();
  const textoDetranSync =
    isCategoriaInfracao(categoria) && descricaoDetran && !pareceDescricaoInfracaoCobranca(descricaoDetran)
      ? descricaoDetran
      : null;
  const reparoInfracao = isCategoriaInfracao(categoria)
    ? repararCamposInfracaoCliente({
        titulo: m.titulo,
        descricao: m.descricao,
        dataAutuacao: dataFinal,
        numeroAuto: input.numeroAuto ?? input.autoInfracao ?? m.numeroAuto ?? m.autoInfracao,
        textoDetranSync,
      })
    : null;
  const manterDescricaoCobranca =
    isCategoriaInfracao(categoria) && pareceDescricaoInfracaoCobranca(m.descricao ?? "");
  const tituloDetran =
    isCategoriaInfracao(categoria)
      ? reparoInfracao?.titulo ??
        (textoDetranSync ??
          (descricaoDetran && !pareceDescricaoInfracaoCobranca(descricaoDetran) ? descricaoDetran : ""))
      : "";
  const tituloMudou = isCategoriaInfracao(categoria) && tituloDetran && (m.titulo ?? "") !== tituloDetran;
  const descricaoPadrao =
    reparoInfracao?.descricao ??
    (isCategoriaInfracao(categoria) && tituloDetran && !manterDescricaoCobranca
      ? descricaoInfracaoCliente(tituloDetran, dataFinal, input.numeroAuto ?? input.autoInfracao ?? m.numeroAuto ?? m.autoInfracao)
      : null);
  const descricaoMudou = descricaoPadrao !== null && (m.descricao ?? "") !== descricaoPadrao;
  const reparoMudou = reparoInfracao?.corrigiu === true;

  if (
    !registroChanged(m, { ...input, categoria }) &&
    !flagRevisarMudou &&
    !desejaConfirmar &&
    !tituloMudou &&
    !descricaoMudou &&
    !reparoMudou
  ) {
    return { registro: m, aviso: null, acao: "sem_alteracao" };
  }

  m.categoria = categoria;
  const sitIn = String(input.situacao ?? "").trim();
  if (sitIn) m.situacao = sitIn;
  const valorIn = parseValorSafe(input.valorMulta);
  if (valorIn > 0) {
    m.valorMulta = valorIn;
  } else if (!(quitadaFinal && m.valorMulta > 0)) {
    m.valorMulta = valorIn;
  }
  const limIn = String(input.limiteDefesa ?? "").trim();
  if (limIn) m.limiteDefesa = limIn;
  if (input.dataLimiteDefesa !== undefined) {
    m.dataLimiteDefesa = String(input.dataLimiteDefesa).trim();
  }
  if (input.dataVencimentoOriginal !== undefined) {
    m.dataVencimentoOriginal = String(input.dataVencimentoOriginal).trim();
  }
  if (input.convertidaEmDebito === true) m.convertidaEmDebito = true;
  if (input.convertidaEmDebito === false) m.convertidaEmDebito = false;
  if (input.numeroAuto !== undefined) {
    m.numeroAuto = String(input.numeroAuto).trim() || undefined;
  } else if (isCategoriaInfracao(categoria) && !m.numeroAuto?.trim()) {
    m.numeroAuto = m.autoInfracao;
  }
  if (!manterDescricaoCobranca) {
    if (isCategoriaInfracao(categoria) && descricaoPadrao) {
      m.descricao = descricaoPadrao;
    } else if (
      !isCategoriaInfracao(categoria) &&
      descricaoDetran &&
      descricaoDetran !== "(sem descrição)"
    ) {
      m.descricao = descricaoDetran;
    } else if (!isCategoriaInfracao(categoria) && !quitadaFinal) {
      m.descricao = descricaoDetran;
    }
  }
  if (tituloDetran) m.titulo = tituloDetran;
  if (input.localInfracao) m.localInfracao = String(input.localInfracao).trim();
  if (input.dataAutuacao) m.dataAutuacao = String(input.dataAutuacao).trim();
  if (input.quitadaDetran === true) m.quitadaDetran = true;
  if (input.quitadaDetran === false) m.quitadaDetran = false;
  if (input.statusInfracao !== undefined) m.statusInfracao = input.statusInfracao;
  if (input.statusDetran !== undefined) m.statusDetran = input.statusDetran;
  m.origem = input.origem ?? m.origem;
  m.atualizadoEm = nowIso();

  // Quitada → marca confirmado (nada a cobrar/vincular); senão resolve por vigência.
  if (quitadaFinal) {
    if (!m.condutorConfirmado) m.condutorConfirmado = true;
    if (m.condutorNaoIdentificado) m.condutorNaoIdentificado = false;
  } else if (!despesaResponsavelConfirmado(m) && !m.condutorId && dataFinal && inferCond) {
    if (parseDataAutuacao(dataFinal)) {
      const res = resolverCondutorVigencia(veiculoId, dataFinal, opts?.prazoDias ?? 90);
      m.condutorId = res.condutorId;
      m.condutorContrato = res.condutorContrato;
      m.condutorNaoIdentificado = res.naoIdentificado;
      m.condutorConfirmado = false;
      m.debitoParceiroConfirmado = false;
      m.debitoParceiroId = null;
    }
  }

  // Sem data válida → marca revisão; não altera vínculo já existente.
  if (inferCond) {
    if (desejaRevisar) {
      m.revisarManual = true;
      m.revisarMotivo = "Sem data de autuação no DETRAN — revisar manualmente";
      m.condutorNaoIdentificado = true;
      m.condutorConfirmado = false;
    } else if (m.revisarManual) {
      m.revisarManual = false;
      m.revisarMotivo = null;
    }
  }

  db.clienteDespesas[idx] = m;
  await saveDespesasMut(db, [m]);

  if (parceiroDebitoConfirmado(m) && categoriaInfereCondutor(categoria)) {
    await espelharClienteDespesaSemLocatarioAsync(m);
    return {
      registro: m,
      aviso: opts?.fonteDetran
        ? `sync ${opts.fonteDetran} — parceiro-despesas`
        : "Espelhado em parceiro-despesas",
      acao: "atualizado",
    };
  }

  const [synced] = await pushAposPersistir([m], opts);
  return {
    registro: synced ?? m,
    aviso: opts?.fonteDetran ? `sync ${opts.fonteDetran}` : null,
    acao: "atualizado",
  };
}

/** Simula sync de cobrança cliente (dry-run) — compara com DB sem gravar. */
export function simularSincronizarClienteDespesa(
  veiculoIdRaw: string,
  input: ClienteDespesaInput,
): SincronizarClienteDespesaResult {
  const db = loadClienteDespesasDb();
  const veiculoId = formatPlacaHyphen(veiculoIdRaw);
  const categoria = input.categoria?.trim() || CategoriaDespesaCliente.Infracao;
  const autoKeyU = String(input.autoInfracao).trim().toUpperCase();
  const idx = db.clienteDespesas.findIndex(
    (m) => m.autoInfracao.trim().toUpperCase() === autoKeyU,
  );

  if (idx < 0) {
    return {
      registro: {
        id: "(dry-run)",
        categoria,
        veiculoId,
        autoInfracao: String(input.autoInfracao).trim(),
        descricao: String(input.descricao ?? "").trim(),
        localInfracao: String(input.localInfracao ?? "").trim(),
        dataAutuacao: String(input.dataAutuacao ?? "").trim(),
        valorMulta: parseValorSafe(input.valorMulta),
        situacao: String(input.situacao ?? "").trim(),
        limiteDefesa: String(input.limiteDefesa ?? "").trim(),
        condutorId: null,
        condutorConfirmado: input.quitadaDetran === true,
        condutorContrato: null,
        quitadaDetran: input.quitadaDetran === true,
        cadastradoEm: "",
        atualizadoEm: "",
        origem: input.origem ?? "manual",
      },
      aviso: null,
      acao: "novo",
    };
  }

  const m = db.clienteDespesas[idx]!;
  if (
    !registroChanged(m, { ...input, categoria }) &&
    !(input.quitadaDetran === true && !m.condutorConfirmado)
  ) {
    return { registro: m, aviso: null, acao: "sem_alteracao" };
  }
  return { registro: m, aviso: null, acao: "atualizado" };
}

/** @deprecated use sincronizarClienteDespesa */
export function sincronizarInfracao(
  veiculoIdRaw: string,
  input: ClienteDespesaInput,
  opts?: ClienteDespesaPersistOpts,
): Promise<SincronizarClienteDespesaResult> {
  return sincronizarClienteDespesa(
    veiculoIdRaw,
    { ...input, categoria: input.categoria ?? CategoriaDespesaCliente.Infracao },
    opts,
  );
}

/** Grava/atualiza o caminho do PDF da infração em infracoes.json e cliente-despesas.json. */
export function atualizarPdfArquivoInfracao(
  autoInfracao: string,
  pdfArquivo: string,
): ClienteDespesaRegistro | null {
  atualizarPdfArquivoInfracaoDb(autoInfracao, pdfArquivo);
  const db = loadClienteDespesasDb();
  const key = autoInfracao.trim().toUpperCase();
  const idx = db.clienteDespesas.findIndex((m) => m.autoInfracao.trim().toUpperCase() === key);
  if (idx < 0) return null;
  const m = db.clienteDespesas[idx]!;
  if (m.pdfArquivo === pdfArquivo) return m;
  m.pdfArquivo = pdfArquivo;
  m.atualizadoEm = nowIso();
  db.clienteDespesas[idx] = m;
  saveClienteDespesasDb(db);
  return m;
}

export async function atualizarPdfArquivoInfracaoAsync(
  autoInfracao: string,
  pdfArquivo: string,
): Promise<ClienteDespesaRegistro | null> {
  await atualizarPdfArquivoInfracaoDbAsync(autoInfracao, pdfArquivo);
  const m = await findClienteDespesaByReferenciaAsync(autoInfracao);
  if (!m) return null;
  if (m.pdfArquivo === pdfArquivo) return m;
  m.pdfArquivo = pdfArquivo;
  m.atualizadoEm = nowIso();
  if (await useRelationalStore()) {
    await persistClienteDespesasRowsAsync([m]);
    return m;
  }
  const db = await loadClienteDespesasDbAsync();
  const key = autoInfracao.trim().toUpperCase();
  const idx = db.clienteDespesas.findIndex((x) => x.autoInfracao.trim().toUpperCase() === key);
  if (idx >= 0) db.clienteDespesas[idx] = m;
  await saveClienteDespesasDbAsync(db);
  return m;
}

export async function confirmarCondutorClienteDespesa(
  autoInfracao: string,
  condutorId?: string | null,
  opts?: Pick<ClienteDespesaPersistOpts, "syncRastreame">,
): Promise<ClienteDespesaRegistro | null> {
  const desvincular = condutorId !== undefined && !String(condutorId ?? "").trim();
  const clienteId =
    condutorId === undefined ? undefined : String(condutorId ?? "").trim() || null;

  if (await useRelationalStore()) {
    const m = await findClienteDespesaByReferenciaAsync(autoInfracao);
    if (!m) return null;
    if (desvincular) {
      // Sem cliente = desvincular e reabrir confirmação (cliente ou parceiro).
      reabrirConfirmacaoResponsavel(m);
      m.revisarManual = false;
      m.revisarMotivo = null;
    } else {
      if (clienteId !== undefined) m.condutorId = clienteId;
      m.condutorConfirmado = true;
      m.condutorNaoIdentificado = false;
      m.debitoParceiroConfirmado = false;
      m.debitoParceiroId = null;
      m.revisarManual = false;
      m.revisarMotivo = null;
    }
    m.atualizadoEm = nowIso();
    await removerParceiroDespesaPorOrigemAsync(
      origemParceiroPedagioSemLocatario(m.veiculoId, m.autoInfracao),
    );
    await updateClienteDespesaRowToSql(
      m as unknown as Record<string, unknown>,
      persistOptsClienteDespesa(m),
    );
    const [synced] = await pushAposPersistir([m], opts);
    return synced ?? m;
  }

  const db = await loadDespesasMut();
  const key = autoInfracao.trim().toUpperCase();
  const idx = db.clienteDespesas.findIndex((m) => m.autoInfracao.trim().toUpperCase() === key);
  if (idx < 0) return null;

  const m = db.clienteDespesas[idx]!;
  if (desvincular) {
    reabrirConfirmacaoResponsavel(m);
    m.revisarManual = false;
    m.revisarMotivo = null;
  } else {
    if (clienteId !== undefined) m.condutorId = clienteId;
    m.condutorConfirmado = true;
    m.condutorNaoIdentificado = false;
    m.debitoParceiroConfirmado = false;
    m.debitoParceiroId = null;
    m.revisarManual = false;
    m.revisarMotivo = null;
  }
  m.atualizadoEm = nowIso();
  removerParceiroDespesaPorOrigem(
    origemParceiroPedagioSemLocatario(m.veiculoId, m.autoInfracao),
  );
  db.clienteDespesas[idx] = m;
  await saveDespesasMut(db, [m]);
  const [synced] = await pushAposPersistir([m], opts);
  return synced ?? m;
}

export async function confirmarDebitoParceiroDespesa(
  autoInfracao: string,
  parceiroId?: string | null,
): Promise<ClienteDespesaRegistro | null> {
  if (await useRelationalStore()) {
    const m = await findClienteDespesaByReferenciaAsync(autoInfracao);
    if (!m) return null;
    m.debitoParceiroConfirmado = true;
    if (parceiroId !== undefined) m.debitoParceiroId = parceiroId;
    m.condutorNaoIdentificado = true;
    m.condutorConfirmado = true;
    m.condutorId = null;
    m.revisarManual = false;
    m.revisarMotivo = null;
    m.atualizadoEm = nowIso();
    await persistClienteDespesasRowsAsync([m]);
    await espelharClienteDespesaSemLocatarioAsync(m);
    return m;
  }

  const db = await loadDespesasMut();
  const key = autoInfracao.trim().toUpperCase();
  const idx = db.clienteDespesas.findIndex((m) => m.autoInfracao.trim().toUpperCase() === key);
  if (idx < 0) return null;

  const m = db.clienteDespesas[idx]!;
  m.debitoParceiroConfirmado = true;
  if (parceiroId !== undefined) m.debitoParceiroId = parceiroId;
  m.condutorNaoIdentificado = true;
  m.condutorConfirmado = true;
  m.condutorId = null;
  m.revisarManual = false;
  m.revisarMotivo = null;
  m.atualizadoEm = nowIso();
  db.clienteDespesas[idx] = m;
  await saveDespesasMut(db, [m]);
  await espelharClienteDespesaSemLocatarioAsync(m);
  return m;
}

/** @deprecated use confirmarCondutorClienteDespesa */
export function confirmarCondutorInfracao(
  autoInfracao: string,
  condutorId?: string | null,
  opts?: Pick<ClienteDespesaPersistOpts, "syncRastreame">,
): Promise<ClienteDespesaRegistro | null> {
  return confirmarCondutorClienteDespesa(autoInfracao, condutorId, opts);
}

export function isInfracaoTransito(r: ClienteDespesaRegistro): boolean {
  return (r.categoria ?? CategoriaDespesaCliente.Infracao) === CategoriaDespesaCliente.Infracao;
}

/** Infração sem data de autuação válida — nova não vincula locatário (vai a parceiro). */
export function isInfracaoSemDataAutuacao(r: ClienteDespesaRegistro): boolean {
  if (!isInfracaoTransito(r)) return false;
  const data = String(r.dataAutuacao ?? "").trim();
  return !data || !parseDataAutuacao(data);
}

/** Pedágio e estacionamento — locatário na data do evento, não o contrato ativo hoje. */
export function categoriaAtribuiPorDataEvento(categoria: string | undefined | null): boolean {
  const c = (categoria ?? "").trim();
  return isCategoriaPedagio(c) || isCategoriaEstacionamento(c);
}

function contratosAtribuicao(ctx?: DespesaAtribuicaoContext): ContratoRegistro[] {
  if (ctx && "contratos" in ctx) return ctx.contratos ?? [];
  return loadContratosDb().contratos;
}

function contratoAtivoPorVeiculoIdDb(veiculoId: string, contratos?: ContratoRegistro[]) {
  if (!isEntityUuid(veiculoId)) return undefined;
  const list = (contratos ?? loadContratosDb().contratos).filter(
    (c) => c.status === StatusContrato.Ativo && c.veiculoId === veiculoId,
  );
  if (list.length === 0) return undefined;
  return list.sort((a, b) => (b.versao ?? 0) - (a.versao ?? 0))[0];
}

/** @deprecated use contratoAtivoPorVeiculoIdDb — placa só para legado JSON. */
function contratoAtivoPorPlacaDb(placa: string, contratos?: ContratoRegistro[]) {
  const p = compactPlaca(placa);
  const list = (contratos ?? loadContratosDb().contratos).filter(
    (c) => c.status === StatusContrato.Ativo && compactPlaca(c.placa ?? c.veiculoId) === p,
  );
  if (list.length === 0) return undefined;
  return list.sort((a, b) => (b.versao ?? 0) - (a.versao ?? 0))[0];
}

export type DespesaAtribuicaoContext = {
  contratos?: ContratoRegistro[];
  veiculos?: VeiculoRegistro[];
};

/** Condutor/locatário na data da despesa (placa + dataAutuacao). Só sync DETRAN / cadastro manual — não usar em listagens ou baixa. */
export function inferirCondutorIdDespesaPorData(
  d: ClienteDespesaRegistro,
  prazoDias = 90,
  veiculos?: VeiculoRegistro[],
): string | null {
  if (d.condutorId?.trim() && isEntityUuid(d.condutorId.trim())) return d.condutorId.trim();
  if (d.condutorNaoIdentificado === true && d.condutorConfirmado === true) return null;
  const data = String(d.dataAutuacao ?? "").trim();
  if (!data || !parseDataAutuacao(data)) return null;
  const placa = resolvePlacaVeiculoCadastro(String(d.veiculoId ?? ""), veiculos);
  return (
    inferirCondutorInfracao(placa, d.dataAutuacao, prazoDias).condutorId ??
    null
  );
}

/**
 * Débito pertence ao cliente no escopo de cobrança/relatório/baixa.
 * Infração, pedágio e estacionamento: só `condutorId` já gravado (sync DETRAN ou confirmação na tela).
 * Demais categorias: contrato ativo / par cliente+veículo quando houver contexto.
 */
export function despesaAtribuidaACliente(
  d: ClienteDespesaRegistro,
  clienteId: string,
  prazoDias = 90,
  ctx?: DespesaAtribuicaoContext,
): boolean {
  if (d.condutorId === clienteId) return true;
  if (d.condutorId && d.condutorId !== clienteId) return false;

  if (isInfracaoTransito(d) || categoriaAtribuiPorDataEvento(d.categoria)) {
    if (isInfracaoTransito(d) && isInfracaoSemDataAutuacao(d)) return false;
    return false;
  }

  const cat = (d.categoria ?? "").trim();
  if (cat === CategoriaDespesaCliente.LocacaoSemanal || cat === CategoriaDespesaCliente.Renegociacao || cat === CategoriaDespesaCliente.Caucao) {
    if (d.condutorId === clienteId) return true;
    if (d.condutorId && d.condutorId !== clienteId) return false;
    const veiculoId =
      (isEntityUuid(d.veiculoId) ? d.veiculoId : null) ??
      resolveVeiculoIdListagem({ placa: resolvePlacaVeiculoCadastro(d.veiculoId, ctx?.veiculos) }, ctx?.veiculos) ??
      null;
    const contrato = contratoMaisRecentePar(
      { veiculoId, clienteId, placa: resolvePlacaVeiculoCadastro(d.veiculoId, ctx?.veiculos) },
      contratosAtribuicao(ctx),
      ctx?.veiculos,
    );
    return contrato?.clienteId === clienteId;
  }

  const veiculoId =
    (isEntityUuid(d.veiculoId) ? d.veiculoId : null) ??
    resolveVeiculoIdListagem({ placa: resolvePlacaVeiculoCadastro(d.veiculoId, ctx?.veiculos) }, ctx?.veiculos) ??
    null;
  if (veiculoId) {
    const vigente = contratoAtivoPorVeiculoIdDb(veiculoId, ctx?.contratos);
    if (vigente) return vigente.clienteId === clienteId;
  }
  const placa = resolvePlacaVeiculoCadastro(d.veiculoId, ctx?.veiculos);
  const vigenteLegado = contratoAtivoPorPlacaDb(placa, ctx?.contratos);
  return vigenteLegado?.clienteId === clienteId;
}

export function autoInfracaoRastreame(rastreameId: string | number): string {
  return `RAST-${rastreameId}`;
}

export function parseRastreameIdFromAuto(autoInfracao: string): string | null {
  const m = String(autoInfracao).trim().match(/^RAST-(\d+)$/i);
  return m ? m[1]! : null;
}

export function isClienteDespesaAtiva(r: ClienteDespesaRegistro): boolean {
  return !isClienteDespesaExcluida(r);
}

function statusCobrancaDeRegistro(
  r: Pick<ClienteDespesaRegistro, "paga" | "statusCobranca">,
): "em_aberto" | "pago" | "baixado" {
  const s = String(r.statusCobranca ?? "").trim();
  if (s === "baixado" || s === "pago" || s === "em_aberto") return s;
  return r.paga === true ? "pago" : "em_aberto";
}

/** Em aberto = ainda devido à Lanza (não pago e não baixado via caução/acerto). */
export function isClienteDespesaEmAberto(
  r: Pick<ClienteDespesaRegistro, "paga" | "statusCobranca">,
): boolean {
  return statusCobrancaDeRegistro(r) === "em_aberto";
}

/** Quitada na Lanza (recebimento registrado na nossa conta). */
export function isClienteDespesaPaga(
  r: Pick<ClienteDespesaRegistro, "paga" | "statusCobranca">,
): boolean {
  return statusCobrancaDeRegistro(r) === "pago";
}

/** Quitada sem caixa (ex.: descontada do caução no encerramento). */
export function isClienteDespesaBaixada(
  r: Pick<ClienteDespesaRegistro, "paga" | "statusCobranca">,
): boolean {
  return statusCobrancaDeRegistro(r) === "baixado";
}

/** Mantém `paga` ↔ `statusCobranca` coerentes após patch. */
function sincronizarStatusCobranca(
  m: ClienteDespesaRegistro,
  patch: Pick<ClienteDespesaPatch, "paga" | "statusCobranca" | "pagaEm">,
): void {
  if (patch.statusCobranca !== undefined) {
    const s = String(patch.statusCobranca).trim();
    if (s === "pago" || s === "baixado" || s === "em_aberto") {
      m.statusCobranca = s;
    }
    m.paga = m.statusCobranca === "pago";
    if (m.statusCobranca !== "pago" && patch.pagaEm === undefined) {
      m.pagaEm = null;
    }
    return;
  }
  if (patch.paga !== undefined) {
    if (patch.paga === true) {
      m.statusCobranca = "pago";
    } else if (m.statusCobranca !== "baixado") {
      m.statusCobranca = "em_aberto";
    }
  }
}

/** Registro legado com soft delete (ativo=false) — novas exclusões removem a linha. */
export function isClienteDespesaExcluida(r: Pick<ClienteDespesaRegistro, "ativo">): boolean {
  return r.ativo === false;
}

export function isLocacaoSemanalEmAberto(d: ClienteDespesaRegistro): boolean {
  return d.categoria === CategoriaDespesaCliente.LocacaoSemanal && isClienteDespesaEmAberto(d);
}

/**
 * Remove espelho cliente de infração (ex.: débito passou a parceiro-despesas
 * por ausência de locatário na data da autuação).
 */
export function inativarEspelhoClienteInfracao(numeroAuto: string): boolean {
  const db = loadClienteDespesasDb();
  const key = String(numeroAuto).trim().toUpperCase();
  const idx = db.clienteDespesas.findIndex(
    (m) => m.autoInfracao.trim().toUpperCase() === key,
  );
  if (idx < 0) return false;
  db.clienteDespesas.splice(idx, 1);
  db.atualizadoEm = new Date().toISOString().slice(0, 10);
  saveClienteDespesasDb(db);
  return true;
}

/** Débito espelhado ou elegível para Gastos Gerais no Rastreame. */
export function isSyncRastreameEligible(r: ClienteDespesaRegistro): boolean {
  if (!isClienteDespesaAtiva(r)) return false;
  if (r.rastreameId != null && r.rastreameId !== "") return true;
  if (r.origem === "rastreame") return true;
  const cat = r.categoria ?? CategoriaDespesaCliente.Infracao;
  if (cat === CategoriaDespesaCliente.Infracao) return false;
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
    | "dataVencimentoOriginal"
    | "condutorId"
    | "condutorContrato"
    | "condutorConfirmado"
    | "condutorNaoIdentificado"
    | "paga"
    | "statusCobranca"
    | "pagaEm"
    | "rastreameMotoristaKey"
    | "rastreameRastreavelKey"
    | "rastreameDataIso"
    | "rastreameTipo"
    | "veiculoId"
  >
>;

export async function editarClienteDespesa(
  idOrAuto: string,
  patch: ClienteDespesaPatch,
  opts?: Pick<ClienteDespesaPersistOpts, "syncRastreame" | "skipProximaParcela">,
): Promise<EditarClienteDespesaResult | null> {
  if (await useRelationalStore()) {
    return editarClienteDespesaRelational(idOrAuto, patch, opts);
  }

  const db = await loadDespesasMut();
  const key = idOrAuto.trim();
  const idx = db.clienteDespesas.findIndex(
    (m) =>
      m.id === key ||
      m.autoInfracao.trim().toUpperCase() === key.toUpperCase(),
  );
  if (idx < 0) return null;

  const m = db.clienteDespesas[idx]!;
  const eraPaga = m.paga === true;
  const descricaoAntes = m.descricao;
  const vencimentoAntes =
    m.categoria === CategoriaDespesaCliente.LocacaoSemanal && isPagamentoSemanalDescricao(m.descricao)
      ? dataVencimentoSemanalBr(m.descricao, m.rastreameDataIso) ?? m.dataAutuacao
      : m.dataAutuacao;

  if (patch.categoria !== undefined) m.categoria = patch.categoria;
  if (patch.descricao !== undefined) m.descricao = String(patch.descricao).trim();
  if (patch.titulo !== undefined) m.titulo = String(patch.titulo).trim();
  if (patch.localInfracao !== undefined) m.localInfracao = String(patch.localInfracao).trim();
  if (patch.dataAutuacao !== undefined) m.dataAutuacao = String(patch.dataAutuacao).trim();
  if (patch.valorMulta !== undefined) m.valorMulta = parseValor(patch.valorMulta);
  if (patch.situacao !== undefined) m.situacao = String(patch.situacao).trim();
  if (patch.limiteDefesa !== undefined) m.limiteDefesa = String(patch.limiteDefesa).trim();
  if (patch.dataVencimentoOriginal !== undefined) {
    m.dataVencimentoOriginal = String(patch.dataVencimentoOriginal).trim();
  }
  const reabriuResponsavel = aplicarCondutorIdPatch(m, patch);
  if (patch.condutorConfirmado !== undefined) m.condutorConfirmado = patch.condutorConfirmado;
  if (patch.condutorNaoIdentificado !== undefined) {
    m.condutorNaoIdentificado = patch.condutorNaoIdentificado;
  }
  if (patch.paga !== undefined) m.paga = patch.paga;
  if (patch.pagaEm !== undefined) {
    m.pagaEm =
      patch.pagaEm == null || patch.pagaEm === ""
        ? null
        : pagaEmInputToIso(patch.pagaEm) ?? String(patch.pagaEm).trim();
  }
  sincronizarStatusCobranca(m, patch);
  if (patch.rastreameMotoristaKey !== undefined) {
    m.rastreameMotoristaKey = patch.rastreameMotoristaKey;
  }
  if (patch.rastreameRastreavelKey !== undefined) {
    m.rastreameRastreavelKey = patch.rastreameRastreavelKey;
  }
  if (patch.rastreameDataIso !== undefined) m.rastreameDataIso = patch.rastreameDataIso;
  if (patch.veiculoId !== undefined) {
    m.veiculoId = resolveVeiculoIdFromDespesaPatch(patch.veiculoId);
  }

  if (m.categoria === CategoriaDespesaCliente.LocacaoSemanal && isPagamentoSemanalDescricao(m.descricao)) {
    const normalized = normalizarBaixaSemanal({
      descricao: m.descricao,
      dataAutuacao: m.dataAutuacao,
      paga: m.paga,
      pagaEm: m.pagaEm,
      rastreameDataIso: m.rastreameDataIso,
    });
    if (normalized.descricao !== undefined) m.descricao = normalized.descricao;
    if (normalized.dataAutuacao !== undefined) m.dataAutuacao = normalized.dataAutuacao;
    if (normalized.rastreameDataIso !== undefined) m.rastreameDataIso = normalized.rastreameDataIso;
  }

  m.atualizadoEm = nowIso();
  db.clienteDespesas[idx] = m;

  if (reabriuResponsavel) {
    removerParceiroDespesaPorOrigem(
      origemParceiroPedagioSemLocatario(m.veiculoId, m.autoInfracao),
    );
  }

  let proximaParcela: ClienteDespesaRegistro | null = null;
  if (
    !opts?.skipProximaParcela &&
    !eraPaga &&
    m.paga === true &&
    m.ativo !== false &&
    m.categoria === CategoriaDespesaCliente.LocacaoSemanal &&
    isPagamentoSemanalDescricao(descricaoAntes)
  ) {
    proximaParcela = criarProximaParcelaSemanalSeNecessario(
      m,
      descricaoAntes,
      vencimentoAntes,
      db,
      valorParcelaSemanalContrato(m.veiculoId) ?? undefined,
    );
  }

  await saveDespesasMut(db, proximaParcela ? [m, proximaParcela!] : [m]);

  const synced = await pushAposPersistir(
    proximaParcela ? [m, proximaParcela] : [m],
    opts,
  );

  return {
    registro: synced[0]!,
    proximaParcela: proximaParcela ? synced[1] ?? null : null,
  };
}

function normDescSemanal(s: string): string {
  return stripAtrasadoSemanal(s)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Vencimento da semana quitada (parcial ou integral) ao registrar o pagamento. */
function vencimentoSemanalParaBaixa(
  descricao: string,
  veiculoId: string,
  pagaEmIso?: string | null,
  rastreameHintIso?: string | null,
  dbIn?: ClienteDespesasDb,
): string | null {
  const db = dbIn ?? loadClienteDespesasDb();
  const placa = formatPlacaHyphen(veiculoId);
  const norm = normDescSemanal(descricao);

  const irma = db.clienteDespesas.find(
    (d) =>
      d.ativo !== false &&
      formatPlacaHyphen(d.veiculoId) === placa &&
      d.categoria === CategoriaDespesaCliente.LocacaoSemanal &&
      normDescSemanal(d.descricao) === norm,
  );
  if (irma) {
    return dataVencimentoSemanalBr(irma.descricao, irma.rastreameDataIso) ?? irma.dataAutuacao;
  }

  const pay = pagaEmIso ? new Date(pagaEmIso) : null;
  for (const hint of [pagaEmIso, rastreameHintIso]) {
    if (!hint) continue;
    const v = dataVencimentoSemanalBr(descricao, hint);
    if (!v) continue;
    if (pay && !Number.isNaN(pay.getTime())) {
      const m = v.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
      if (m) {
        const venc = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 12, 0, 0);
        if (venc.getTime() > pay.getTime()) {
          venc.setMonth(venc.getMonth() - 1);
          return formatDataBr(venc);
        }
      }
    }
    return v;
  }
  return null;
}

function valorParcelaSemanalContrato(veiculoId: string): number | null {
  const ref = veiculoId.trim();
  const fromCtx = getCobrancasRuntimeCtx()?.contratos;
  // Se o runtime ctx existe (mesmo vazio), não cair no load síncrono (deadlock no Postgres).
  const contratos = fromCtx != null ? fromCtx : loadContratosDb().contratos;
  const placaNorm = isEntityUuid(ref) ? null : formatPlacaHyphen(ref);
  const contrato = contratos.find((c) => {
    if (c.status !== StatusContrato.Ativo) return false;
    const cVid = String(c.veiculoId ?? "").trim();
    if (isEntityUuid(ref) && isEntityUuid(cVid)) return cVid === ref;
    return formatPlacaHyphen(c.veiculoId ?? c.placa ?? "") === (placaNorm ?? formatPlacaHyphen(ref));
  });
  return contrato?.valorSemanal ?? null;
}

/**
 * Remove vínculo de responsável e reabre a confirmação (cliente ou parceiro).
 * Usado ao limpar o cliente da despesa.
 */
function reabrirConfirmacaoResponsavel(m: ClienteDespesaRegistro): void {
  m.condutorId = null;
  m.condutorConfirmado = false;
  m.condutorNaoIdentificado = false;
  m.condutorContrato = null;
  m.debitoParceiroConfirmado = false;
  m.debitoParceiroId = null;
}

/** Aplica `condutorId` do patch; limpar (null/vazio) reabre confirmação. Retorna true se reabriu. */
function aplicarCondutorIdPatch(m: ClienteDespesaRegistro, patch: ClienteDespesaPatch): boolean {
  if (patch.condutorId === undefined) return false;
  const next =
    patch.condutorId == null ? null : String(patch.condutorId).trim() || null;
  const anterior = m.condutorId?.trim() || null;
  if (!next) {
    // Só reabre se havia cliente vinculado — evita desfazer confirmação de parceiro ao gravar outros campos.
    if (anterior) {
      reabrirConfirmacaoResponsavel(m);
      return true;
    }
    m.condutorId = null;
    return false;
  }
  m.condutorId = next;
  return false;
}

function applyClienteDespesaPatch(
  m: ClienteDespesaRegistro,
  patch: ClienteDespesaPatch,
  veiculos?: VeiculoRegistro[],
): void {
  if (patch.categoria !== undefined) m.categoria = patch.categoria;
  if (patch.descricao !== undefined) m.descricao = String(patch.descricao).trim();
  if (patch.titulo !== undefined) m.titulo = String(patch.titulo).trim();
  if (patch.localInfracao !== undefined) m.localInfracao = String(patch.localInfracao).trim();
  if (patch.dataAutuacao !== undefined) m.dataAutuacao = String(patch.dataAutuacao).trim();
  if (patch.valorMulta !== undefined) m.valorMulta = parseValor(patch.valorMulta);
  if (patch.situacao !== undefined) m.situacao = String(patch.situacao).trim();
  if (patch.limiteDefesa !== undefined) m.limiteDefesa = String(patch.limiteDefesa).trim();
  if (patch.dataVencimentoOriginal !== undefined) {
    m.dataVencimentoOriginal = String(patch.dataVencimentoOriginal).trim();
  }
  aplicarCondutorIdPatch(m, patch);
  if (patch.condutorConfirmado !== undefined) m.condutorConfirmado = patch.condutorConfirmado;
  if (patch.condutorNaoIdentificado !== undefined) {
    m.condutorNaoIdentificado = patch.condutorNaoIdentificado;
  }
  if (patch.paga !== undefined) m.paga = patch.paga;
  if (patch.pagaEm !== undefined) {
    m.pagaEm =
      patch.pagaEm == null || patch.pagaEm === ""
        ? null
        : pagaEmInputToIso(patch.pagaEm) ?? String(patch.pagaEm).trim();
  }
  sincronizarStatusCobranca(m, patch);
  if (patch.rastreameMotoristaKey !== undefined) {
    m.rastreameMotoristaKey = patch.rastreameMotoristaKey;
  }
  if (patch.rastreameRastreavelKey !== undefined) {
    m.rastreameRastreavelKey = patch.rastreameRastreavelKey;
  }
  if (patch.rastreameDataIso !== undefined) m.rastreameDataIso = patch.rastreameDataIso;
  if (patch.veiculoId !== undefined) {
    m.veiculoId = resolveVeiculoIdFromDespesaPatch(patch.veiculoId, veiculos);
  }

  if (m.categoria === CategoriaDespesaCliente.LocacaoSemanal && isPagamentoSemanalDescricao(m.descricao)) {
    const normalized = normalizarBaixaSemanal({
      descricao: m.descricao,
      dataAutuacao: m.dataAutuacao,
      paga: m.paga,
      pagaEm: m.pagaEm,
      rastreameDataIso: m.rastreameDataIso,
    });
    if (normalized.descricao !== undefined) m.descricao = normalized.descricao;
    if (normalized.dataAutuacao !== undefined) m.dataAutuacao = normalized.dataAutuacao;
    if (normalized.rastreameDataIso !== undefined) m.rastreameDataIso = normalized.rastreameDataIso;
  }

  m.atualizadoEm = nowIso();
}

function findClienteDespesaInRuntimeCtx(key: string): ClienteDespesaRegistro | null {
  const k = key.trim();
  const ku = k.toUpperCase();
  const ctx = getCobrancasRuntimeCtx()?.clienteDespesas;
  if (!ctx?.length) return null;
  return (
    ctx.find((m) => m.id === k) ??
    ctx.find((m) => m.autoInfracao.trim().toUpperCase() === ku) ??
    null
  );
}

async function resolveClienteDespesaForEdit(key: string): Promise<ClienteDespesaRegistro | null> {
  const fromCtx = findClienteDespesaInRuntimeCtx(key);
  if (fromCtx) return { ...fromCtx };
  const row = await queryClienteDespesaByReferenciaFromSql(key);
  return row ? (row as ClienteDespesaRegistro) : null;
}

function persistOptsClienteDespesa(d: ClienteDespesaRegistro): PersistClienteDespesaSqlOpts {
  return {
    veiculoId: isEntityUuid(d.veiculoId) ? d.veiculoId : undefined,
    skipInfracaoLookup: (d.categoria ?? CategoriaDespesaCliente.Infracao) !== CategoriaDespesaCliente.Infracao,
  };
}

function despesaSemanalDescricaoDuplicada(
  veiculoId: string,
  descricaoNorm: string,
  extras: ClienteDespesaRegistro[] = [],
): boolean {
  const ctxDespesas = getCobrancasRuntimeCtx()?.clienteDespesas ?? [];
  const pool = [...extras, ...ctxDespesas];
  return pool.some(
    (d) =>
      d.ativo !== false &&
      d.veiculoId === veiculoId &&
      d.categoria === CategoriaDespesaCliente.LocacaoSemanal &&
      normDescSemanal(d.descricao) === descricaoNorm,
  );
}

async function despesaSemanalDescricaoDuplicadaAsync(
  veiculoId: string,
  descricaoNorm: string,
  extras: ClienteDespesaRegistro[] = [],
): Promise<boolean> {
  if (despesaSemanalDescricaoDuplicada(veiculoId, descricaoNorm, extras)) return true;
  const veiculoUuid = isEntityUuid(veiculoId)
    ? veiculoId
    : resolveVeiculoIdListagem({ placa: veiculoId }, getCobrancasRuntimeCtx()?.veiculos);
  if (!veiculoUuid) return false;
  const rows = (await queryClienteDespesasFromSql({
    veiculoId: veiculoUuid,
    ativo: true,
    emAberto: true,
  })) as ClienteDespesaRegistro[];
  return rows.some(
    (d) =>
      d.categoria === CategoriaDespesaCliente.LocacaoSemanal && normDescSemanal(String(d.descricao ?? "")) === descricaoNorm,
  );
}

function buildProximaParcelaSemanalRegistro(
  pago: ClienteDespesaRegistro,
  prox: { descricao: string; dataAutuacao: string; rastreameDataIso?: string | null },
  valorParcela?: number,
): ClienteDespesaRegistro {
  const ts = nowIso();
  return {
    id: crypto.randomUUID(),
    categoria: CategoriaDespesaCliente.LocacaoSemanal,
    veiculoId: pago.veiculoId,
    autoInfracao: `LOCAL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    descricao: prox.descricao,
    localInfracao: "",
    dataAutuacao: prox.dataAutuacao,
    valorMulta:
      valorParcela ?? valorParcelaSemanalContrato(pago.veiculoId) ?? pago.valorMulta,
    situacao: "Em aberto",
    limiteDefesa: "",
    condutorId: pago.condutorId,
    condutorConfirmado: pago.condutorConfirmado,
    condutorContrato: pago.condutorContrato,
    paga: false,
    statusCobranca: "em_aberto",
    pagaEm: null,
    rastreameMotoristaKey: pago.rastreameMotoristaKey ?? null,
    rastreameRastreavelKey: pago.rastreameRastreavelKey ?? null,
    rastreameDataIso: prox.rastreameDataIso,
    rastreameTipo: pago.rastreameTipo ?? "OUTROS",
    ativo: true,
    cadastradoEm: ts,
    atualizadoEm: ts,
    origem: "manual",
  };
}

async function criarProximaParcelaSemanalRelational(
  pago: ClienteDespesaRegistro,
  descricaoAntes: string,
  vencimentoAntes: string,
  valorParcela?: number,
  skipDupSemanal = false,
): Promise<ClienteDespesaRegistro | null> {
  const prox = proximaParcelaSemanal(descricaoAntes, vencimentoAntes);
  if (!prox) return null;
  const alvo = normDescSemanal(prox.descricao);
  if (!skipDupSemanal) {
    if (despesaSemanalDescricaoDuplicada(pago.veiculoId, alvo)) return null;
    if (!getCobrancasRuntimeCtx()?.clienteDespesas?.length) {
      if (await despesaSemanalDescricaoDuplicadaAsync(pago.veiculoId, alvo)) return null;
    }
  }
  return buildProximaParcelaSemanalRegistro(pago, prox, valorParcela);
}

async function editarClienteDespesaRelational(
  idOrAuto: string,
  patch: ClienteDespesaPatch,
  opts?: Pick<ClienteDespesaPersistOpts, "syncRastreame" | "skipProximaParcela">,
): Promise<EditarClienteDespesaResult | null> {
  const key = idOrAuto.trim();
  const row = await resolveClienteDespesaForEdit(key);
  if (!row) return null;

  const m = row;
  const veiculos = getCobrancasRuntimeCtx()?.veiculos;
  const eraPaga = m.paga === true;
  const descricaoAntes = m.descricao;
  const vencimentoAntes =
    m.categoria === CategoriaDespesaCliente.LocacaoSemanal && isPagamentoSemanalDescricao(m.descricao)
      ? dataVencimentoSemanalBr(m.descricao, m.rastreameDataIso) ?? m.dataAutuacao
      : m.dataAutuacao;

  const reabriuResponsavel = patch.condutorId !== undefined && !(String(patch.condutorId ?? "").trim());
  applyClienteDespesaPatch(m, patch, veiculos);

  if (reabriuResponsavel) {
    await removerParceiroDespesaPorOrigemAsync(
      origemParceiroPedagioSemLocatario(m.veiculoId, m.autoInfracao),
    );
  }

  let proximaParcela: ClienteDespesaRegistro | null = null;
  if (
    !opts?.skipProximaParcela &&
    !eraPaga &&
    m.paga === true &&
    m.ativo !== false &&
    m.categoria === CategoriaDespesaCliente.LocacaoSemanal &&
    isPagamentoSemanalDescricao(descricaoAntes)
  ) {
    // Sempre o valor semanal do contrato — não o residual da despesa quitada.
    proximaParcela = await criarProximaParcelaSemanalRelational(
      m,
      descricaoAntes,
      vencimentoAntes,
      valorParcelaSemanalContrato(m.veiculoId) ?? undefined,
    );
  }

  const persistOpts = persistOptsClienteDespesa(m);
  await updateClienteDespesaRowToSql(m as unknown as Record<string, unknown>, persistOpts);
  if (proximaParcela) {
    await upsertClienteDespesaRowToSql(
      proximaParcela as unknown as Record<string, unknown>,
      persistOptsClienteDespesa(proximaParcela),
    );
  }

  const fresh =
    (await queryClienteDespesaByReferenciaFromSql(m.id)) ??
    (await queryClienteDespesaByReferenciaFromSql(m.autoInfracao));
  const registro = (fresh ?? m) as ClienteDespesaRegistro;
  let proximaSync = proximaParcela;
  if (proximaParcela) {
    const freshProx =
      (await queryClienteDespesaByReferenciaFromSql(proximaParcela.id)) ??
      (await queryClienteDespesaByReferenciaFromSql(proximaParcela.autoInfracao));
    if (freshProx) proximaSync = freshProx as ClienteDespesaRegistro;
  }

  const synced = await pushAposPersistir(
    proximaSync ? [registro, proximaSync] : [registro],
    opts,
  );

  return {
    registro: synced[0]!,
    proximaParcela: proximaSync ? synced[1] ?? null : null,
  };
}

function criarProximaParcelaSemanalSeNecessario(
  pago: ClienteDespesaRegistro,
  descricaoAntes: string,
  vencimentoAntes: string,
  db: ClienteDespesasDb,
  valorParcela?: number,
): ClienteDespesaRegistro | null {
  const prox = proximaParcelaSemanal(descricaoAntes, vencimentoAntes);
  if (!prox) return null;
  const alvo = normDescSemanal(prox.descricao);
  const dup = db.clienteDespesas.find(
    (d) =>
      d.ativo !== false &&
      d.veiculoId === pago.veiculoId &&
      d.categoria === CategoriaDespesaCliente.LocacaoSemanal &&
      normDescSemanal(d.descricao) === alvo,
  );
  if (dup) return null;

  const ts = nowIso();
  const registro: ClienteDespesaRegistro = {
    id: crypto.randomUUID(),
    categoria: CategoriaDespesaCliente.LocacaoSemanal,
    veiculoId: pago.veiculoId,
    autoInfracao: `LOCAL-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
    descricao: prox.descricao,
    localInfracao: "",
    dataAutuacao: prox.dataAutuacao,
    valorMulta:
      valorParcela ?? valorParcelaSemanalContrato(pago.veiculoId) ?? pago.valorMulta,
    situacao: "Em aberto",
    limiteDefesa: "",
    condutorId: pago.condutorId,
    condutorConfirmado: pago.condutorConfirmado,
    condutorContrato: pago.condutorContrato,
    paga: false,
    statusCobranca: "em_aberto",
    pagaEm: null,
    rastreameMotoristaKey: pago.rastreameMotoristaKey ?? null,
    rastreameRastreavelKey: pago.rastreameRastreavelKey ?? null,
    rastreameDataIso: prox.rastreameDataIso,
    rastreameTipo: pago.rastreameTipo ?? "OUTROS",
    ativo: true,
    cadastradoEm: ts,
    atualizadoEm: ts,
    origem: "manual",
  };
  db.clienteDespesas.push(registro);
  return registro;
}

async function findClienteDespesaForDelete(key: string): Promise<ClienteDespesaRegistro | null> {
  const trimmed = key.trim();
  const fromCtx = findClienteDespesaInRuntimeCtx(trimmed);
  if (fromCtx) return { ...fromCtx };
  if (await useRelationalStore()) {
    const row = await queryClienteDespesaByReferenciaFromSql(trimmed, { includeInativas: true });
    return row ? (row as ClienteDespesaRegistro) : null;
  }
  const db = loadClienteDespesasDb();
  const ku = trimmed.toUpperCase();
  return (
    db.clienteDespesas.find((m) => m.id === trimmed) ??
    db.clienteDespesas.find((m) => m.autoInfracao.trim().toUpperCase() === ku) ??
    null
  );
}

export async function excluirClienteDespesa(
  idOrAuto: string,
  opts?: Pick<ClienteDespesaPersistOpts, "syncRastreame">,
): Promise<ClienteDespesaRegistro | null> {
  const reg = await findClienteDespesaForDelete(idOrAuto);
  if (!reg) return null;

  if (opts?.syncRastreame !== false && reg.rastreameId != null && String(reg.rastreameId).trim() !== "") {
    try {
      const { excluirGasto } = await import("./rastreame/gasto.js");
      await excluirGasto(reg.rastreameId);
    } catch {
      /* Rastreame indisponível — exclusão local segue */
    }
  }

  if (await useRelationalStore()) {
    const ok = await deleteClienteDespesaFromSql(reg.id);
    if (!ok) return null;
    return reg;
  }

  const db = loadClienteDespesasDb();
  const idx = db.clienteDespesas.findIndex((m) => m.id === reg.id);
  if (idx < 0) return null;
  db.clienteDespesas.splice(idx, 1);
  db.atualizadoEm = new Date().toISOString().slice(0, 10);
  saveClienteDespesasDb(db);
  return reg;
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
  detranAutoInfracao?: string | null;
  force?: boolean;
};

/** Auto de infração DETRAN a partir do campo `comprovante` do Rastreame. */
export function extrairDetranAutoComprovante(comprovante: unknown): string | null {
  const t = String(comprovante ?? "").trim();
  if (!t) return null;
  if (/^RAST-\d+$/i.test(t)) return null;
  const up = t.toUpperCase();
  if (/^[A-Z][A-Z0-9-]{5,}$/.test(up)) return up;
  return null;
}

/** Auto DETRAN para gravar em `comprovante` no Rastreame (tipo MULTA). */
export function comprovanteDetranParaPush(reg: ClienteDespesaRegistro): string | null {
  if (!isCategoriaInfracao(reg.categoria)) return null;
  const linked = reg.detranAutoInfracao?.trim();
  if (linked) return linked.toUpperCase();
  const auto = reg.autoInfracao.trim();
  if (auto && !/^RAST-\d+$/i.test(auto)) return auto.toUpperCase();
  return null;
}

/**
 * Espelho Rastreame (MULTA) ↔ registro DETRAN local via `comprovante`.
 * Rastreame é fonte da verdade para quitacao (`paga`); DETRAN preserva texto/local.
 */
export function vincularInfracaoDetranComRastreame(
  rastreameId: string | number,
  detranAuto: string,
): ClienteDespesaRegistro | null {
  const db = loadClienteDespesasDb();
  const rid = String(rastreameId);
  const autoKey = detranAuto.trim().toUpperCase();
  const idxRast = db.clienteDespesas.findIndex(
    (m) => m.rastreameId != null && String(m.rastreameId) === rid,
  );
  const idxDetran = db.clienteDespesas.findIndex(
    (m) => m.autoInfracao.trim().toUpperCase() === autoKey,
  );
  if (idxRast < 0) return null;

  const rast = db.clienteDespesas[idxRast]!;
  rast.detranAutoInfracao = autoKey;

  if (idxDetran >= 0) {
    const detran = db.clienteDespesas[idxDetran]!;
    if (!rast.descricao?.trim() && detran.descricao?.trim()) {
      rast.descricao = detran.descricao;
    }
    if (!rast.localInfracao?.trim() && detran.localInfracao?.trim()) {
      rast.localInfracao = detran.localInfracao;
    }
    if (!rast.limiteDefesa?.trim() && detran.limiteDefesa?.trim()) {
      rast.limiteDefesa = detran.limiteDefesa;
    }
    if (!rast.numeroAuto?.trim() && detran.numeroAuto?.trim()) {
      rast.numeroAuto = detran.numeroAuto;
    }
    if (!rast.dataLimiteDefesa?.trim() && detran.dataLimiteDefesa?.trim()) {
      rast.dataLimiteDefesa = detran.dataLimiteDefesa;
    }
    if (!rast.dataVencimentoOriginal?.trim() && detran.dataVencimentoOriginal?.trim()) {
      rast.dataVencimentoOriginal = detran.dataVencimentoOriginal;
    }
    if (detran.convertidaEmDebito === true) rast.convertidaEmDebito = true;
    if (!rast.statusInfracao?.trim() && detran.statusInfracao?.trim()) {
      rast.statusInfracao = detran.statusInfracao;
    }
    if (!rast.statusDetran?.trim() && detran.statusDetran?.trim()) {
      rast.statusDetran = detran.statusDetran;
    }
    if (detran.condutorConfirmado && !rast.condutorConfirmado) {
      rast.condutorId = detran.condutorId;
      rast.condutorConfirmado = detran.condutorConfirmado;
      rast.condutorContrato = detran.condutorContrato;
    }
    if (detran.titulo?.trim() && !rast.titulo?.trim()) {
      rast.titulo = detran.titulo;
    }

    detran.rastreameId = rast.rastreameId;
    detran.detranAutoInfracao = autoKey;
    detran.paga = rast.paga;
    detran.pagaEm = rast.pagaEm ?? detran.pagaEm ?? null;
    if (rast.paga === true) {
      detran.situacao = "Registrado";
    } else if (rast.situacao) {
      detran.situacao = rast.situacao;
    }
    detran.atualizadoEm = nowIso();
    db.clienteDespesas[idxDetran] = detran;
  }

  rast.atualizadoEm = nowIso();
  db.clienteDespesas[idxRast] = rast;
  saveClienteDespesasDb(db);
  return rast;
}

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
    const camposInfracao = isInfra
      ? normalizarCamposInfracaoCliente({
          textoDetran: input.titulo?.trim() || input.descricao,
          dataAutuacao: input.dataAutuacao,
          numeroAuto: autoKey,
          paga: input.paga,
          situacao: input.situacao,
          descricaoRastreame: pareceDescricaoInfracaoCobranca(input.descricao)
            ? input.descricao
            : null,
        })
      : null;
    const registro: ClienteDespesaRegistro = {
      id: crypto.randomUUID(),
      categoria: input.categoria,
      veiculoId,
      autoInfracao: autoKey,
      descricao: camposInfracao?.descricao ?? input.descricao,
      titulo: camposInfracao?.titulo ?? (input.titulo?.trim() || undefined),
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
      detranAutoInfracao: input.detranAutoInfracao ?? null,
      rastreameSyncEm: ts,
      ativo: true,
      cadastradoEm: ts,
      atualizadoEm: ts,
      origem: "rastreame",
    };
    db.clienteDespesas.push(registro);
    saveClienteDespesasDb(db);
    if (input.detranAutoInfracao) {
      vincularInfracaoDetranComRastreame(input.rastreameId, input.detranAutoInfracao);
    }
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

  // Infração: `titulo` = DETRAN; `descricao` = padrão de cobrança (Pagamento infração …).
  const reparoRastreame = isInfra
    ? repararCamposInfracaoCliente({
        titulo: input.titulo ?? m.titulo,
        descricao: input.descricao ?? m.descricao,
        dataAutuacao: input.dataAutuacao || m.dataAutuacao,
        numeroAuto: autoKey,
        textoDetranSync:
          input.descricao?.trim() && !pareceDescricaoInfracaoCobranca(input.descricao)
            ? input.descricao
            : m.descricao?.trim() && !pareceDescricaoInfracaoCobranca(m.descricao)
              ? m.descricao
              : input.titulo?.trim() && !pareceDescricaoInfracaoCobranca(input.titulo)
                ? input.titulo
                : null,
      })
    : null;
  const camposRastreameInfra =
    isInfra && reparoRastreame
      ? reparoRastreame
      : isInfra
        ? normalizarCamposInfracaoCliente({
            textoDetran:
              (input.titulo?.trim() && !pareceDescricaoInfracaoCobranca(input.titulo)
                ? input.titulo
                : m.titulo?.trim() && !pareceDescricaoInfracaoCobranca(m.titulo)
                  ? m.titulo
                  : m.descricao?.trim() && !pareceDescricaoInfracaoCobranca(m.descricao)
                    ? m.descricao
                    : stripAtrasado(input.descricao)) ?? "",
            dataAutuacao: input.dataAutuacao || m.dataAutuacao,
            numeroAuto: autoKey,
            descricaoRastreame: pareceDescricaoInfracaoCobranca(input.descricao)
              ? input.descricao
              : pareceDescricaoInfracaoCobranca(input.titulo)
                ? input.titulo
                : null,
          })
        : null;
  const changed =
    (isInfra
      ? (m.titulo ?? "") !== (camposRastreameInfra?.titulo ?? "") ||
        (m.descricao ?? "") !== (camposRastreameInfra?.descricao ?? "")
      : m.descricao !== input.descricao) ||
    m.valorMulta !== input.valorMulta ||
    m.situacao !== input.situacao ||
    m.dataAutuacao !== input.dataAutuacao ||
    m.paga !== input.paga ||
    m.categoria !== input.categoria ||
    m.veiculoId !== veiculoId;

  m.categoria = input.categoria;
  m.veiculoId = veiculoId;
  if (isInfra && camposRastreameInfra) {
    m.titulo = camposRastreameInfra.titulo;
    m.descricao = camposRastreameInfra.descricao;
  } else if (isInfra) {
    if (input.descricao?.trim()) m.descricao = input.descricao.trim();
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
  if (input.detranAutoInfracao) m.detranAutoInfracao = input.detranAutoInfracao;
  m.rastreameSyncEm = ts;
  m.ativo = true;
  m.origem = m.origem === "manual" ? m.origem : "rastreame";
  m.atualizadoEm = ts;
  db.clienteDespesas[idx] = m;
  saveClienteDespesasDb(db);
  if (input.detranAutoInfracao) {
    vincularInfracaoDetranComRastreame(input.rastreameId, input.detranAutoInfracao);
  }
  return {
    registro: m,
    aviso: null,
    acao: changed ? "atualizado" : "sem_alteracao",
  };
}

/** Corrige infrações com titulo/descricao invertidos (legado Rastreame). */
export function repararCamposInfracaoInvertidosNoDb(opts?: {
  dryRun?: boolean;
}): { atualizados: number; exemplos: string[] } {
  const db = loadClienteDespesasDb();
  let atualizados = 0;
  const exemplos: string[] = [];
  const changed: ClienteDespesaRegistro[] = [];

  for (const m of db.clienteDespesas) {
    if (m.ativo === false || !isCategoriaInfracao(m.categoria)) continue;
    const reparo = repararCamposInfracaoCliente({
      titulo: m.titulo,
      descricao: m.descricao,
      dataAutuacao: m.dataAutuacao,
      numeroAuto: m.numeroAuto ?? m.autoInfracao,
    });
    if (!reparo?.corrigiu) continue;
    if (exemplos.length < 3) {
      exemplos.push(
        `${m.autoInfracao}: titulo «${m.titulo ?? ""}» → «${reparo.titulo}»; descricao → «${reparo.descricao}»`,
      );
    }
    if (!opts?.dryRun) {
      m.titulo = reparo.titulo;
      m.descricao = reparo.descricao;
      m.atualizadoEm = nowIso();
      changed.push(m);
    }
    atualizados++;
  }

  if (!opts?.dryRun && changed.length > 0) {
    saveClienteDespesasDb(db);
  }
  return { atualizados, exemplos };
}

export async function repararCamposInfracaoInvertidosNoDbAsync(opts?: {
  dryRun?: boolean;
}): Promise<{ atualizados: number; exemplos: string[] }> {
  const db = await loadClienteDespesasDbAsync();
  let atualizados = 0;
  const exemplos: string[] = [];
  const changed: ClienteDespesaRegistro[] = [];

  for (const m of db.clienteDespesas) {
    if (m.ativo === false || !isCategoriaInfracao(m.categoria)) continue;
    const reparo = repararCamposInfracaoCliente({
      titulo: m.titulo,
      descricao: m.descricao,
      dataAutuacao: m.dataAutuacao,
      numeroAuto: m.numeroAuto ?? m.autoInfracao,
    });
    if (!reparo?.corrigiu) continue;
    if (exemplos.length < 3) {
      exemplos.push(
        `${m.autoInfracao}: titulo «${m.titulo ?? ""}» → «${reparo.titulo}»; descricao → «${reparo.descricao}»`,
      );
    }
    if (!opts?.dryRun) {
      m.titulo = reparo.titulo;
      m.descricao = reparo.descricao;
      m.atualizadoEm = nowIso();
      changed.push(m);
    }
    atualizados++;
  }

  if (!opts?.dryRun && changed.length > 0) {
    await saveDespesasMut(db, changed);
  }
  return { atualizados, exemplos };
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
