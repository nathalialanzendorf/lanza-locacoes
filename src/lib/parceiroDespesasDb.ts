import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { compactPlaca, formatPlacaHyphen } from "./placa.js";
import { REPO_ROOT } from "./repoRoot.js";

export const DB_PARCEIRO_DESPESAS = path.join(
  REPO_ROOT,
  "database",
  "parceiro-despesas.json",
);
const DB_DESPESAS_LEGACY = path.join(REPO_ROOT, "database", "despesas.json");
export const DB_VEICULOS = path.join(REPO_ROOT, "database", "veiculos.json");

export type ParceiroDespesaRegistro = {
  id: string;
  veiculoId: string | null;
  placa: string;
  categoria: string;
  descricao: string;
  data: string;
  valor: number;
  competencia: string;
  origem: string;
  /** id da Manutenção espelhada no Rastreame (despesa de parceiro → tela Manutenção). */
  rastreameManutencaoId?: string | number | null;
  /** Instante (ISO) do último push para o Rastreame. */
  rastreameSyncEm?: string | null;
  /** Hash do conteúdo enviado ao Rastreame (evita PUT desnecessário). */
  rastreameHash?: string | null;
  /**
   * Data da **baixa** (DD/MM/AAAA) — débito pago/quitado/resolvido. Enquanto
   * vazio (`null`/ausente), uma despesa vencida (ex.: IPVA, Licenciamento) segue
   * aparecendo como pendência/lembrete no relatório de prestação de contas.
   */
  baixa?: string | null;
};

export type ParceiroDespesaInput = {
  placa: string;
  categoria: string;
  descricao: string;
  data: string;
  valor: number | string;
  competencia?: string;
  origem?: string;
};

/** @deprecated use ParceiroDespesaInput */
export type DespesaInput = ParceiroDespesaInput;

/** @deprecated use ParceiroDespesaRegistro */
export type DespesaRegistro = ParceiroDespesaRegistro;

type ParceiroDespesasDb = {
  descricao?: string;
  atualizadoEm?: string;
  schemaParceiroDespesa?: Record<string, string>;
  /** @deprecated leitura legacy */
  schemaDespesa?: Record<string, string>;
  parceiroDespesas: ParceiroDespesaRegistro[];
};

const DEFAULT_SCHEMA: Record<string, string> = {
  id: "uuid (despesa)",
  veiculoId: "uuid -> veiculos.json (null se placa não cadastrada)",
  placa: "Placa do veículo (ABC-1D23)",
  categoria: "Seguro | Rastreador | Manutenção | IPVA | Licenciamento | Outros",
  descricao: "Descrição do débito",
  data: "DD/MM/AAAA (vencimento/competência)",
  valor: "número (reais)",
  competencia: "MM/AAAA",
  origem: "manual | detran-sc | caminho boleto | ...",
  rastreameManutencaoId: "id da Manutenção espelhada no Rastreame (null se ainda não enviada)",
  rastreameSyncEm: "ISO do último push para o Rastreame (tela Manutenção)",
  baixa: "DD/MM/AAAA da quitação (null/ausente = em aberto; vencida vira pendência no relatório)",
};

const DEFAULT_DESCRICAO =
  "Débitos a cobrar dos parceiros/donos por veículo (IPVA, Licenciamento, Seguro, Rastreador, Manutenção, etc.). Consumido por relatorio-prestacao-contas.";

function parseValor(v: number | string): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v * 100) / 100;
  const s = String(v).replace(/R\$\s*/i, "").trim();
  const n = s.includes(",")
    ? parseFloat(s.replace(/\./g, "").replace(",", "."))
    : parseFloat(s);
  if (!Number.isFinite(n)) throw new Error(`Valor inválido: ${v}`);
  return Math.round(n * 100) / 100;
}

export function competenciaFromData(data: string): string {
  const m1 = data.match(/(\d{2})\/(\d{4})$/);
  if (m1) return `${m1[1]}/${m1[2]}`;
  const m2 = data.match(/^\d{2}\/(\d{2})\/(\d{4})/);
  if (m2) return `${m2[1]}/${m2[2]}`;
  return "";
}

/** Chave de negócio para dedupe idempotente (syncs e manual). */
export function chaveNegocioParceiroDespesa(
  placa: string,
  competencia: string,
  categoria: string,
  descricao?: string,
  manual = false,
): string {
  const base = `${compactPlaca(placa)}|${competencia}|${String(categoria).trim().toLowerCase()}`;
  if (manual && descricao) {
    return `${base}|${String(descricao).trim().toLowerCase()}`;
  }
  return base;
}

function resolveVeiculo(placa: string): { id: string | null; placa: string } {
  const veic = JSON.parse(fs.readFileSync(DB_VEICULOS, "utf8")) as {
    veiculos: { id: string; placa: string }[];
  };
  const key = compactPlaca(placa);
  const v = veic.veiculos.find((x) => compactPlaca(x.placa) === key);
  return { id: v?.id ?? null, placa: v?.placa ?? formatPlacaHyphen(placa) };
}

function normalizeRawDb(raw: Record<string, unknown>): ParceiroDespesasDb {
  const parceiroDespesas = (raw.parceiroDespesas ??
    raw.despesas ??
    []) as ParceiroDespesaRegistro[];
  return {
    descricao: (raw.descricao as string) || DEFAULT_DESCRICAO,
    atualizadoEm: (raw.atualizadoEm as string) || new Date().toISOString().slice(0, 10),
    schemaParceiroDespesa:
      (raw.schemaParceiroDespesa as Record<string, string>) ||
      (raw.schemaDespesa as Record<string, string>) ||
      DEFAULT_SCHEMA,
    parceiroDespesas,
  };
}

function migrateLegacyDespesasIfNeeded(): void {
  if (fs.existsSync(DB_PARCEIRO_DESPESAS) || !fs.existsSync(DB_DESPESAS_LEGACY)) return;
  const raw = JSON.parse(fs.readFileSync(DB_DESPESAS_LEGACY, "utf8")) as Record<
    string,
    unknown
  >;
  saveParceiroDespesasDb(normalizeRawDb(raw));
  fs.unlinkSync(DB_DESPESAS_LEGACY);
}

export function loadParceiroDespesasDb(): ParceiroDespesasDb {
  migrateLegacyDespesasIfNeeded();
  if (!fs.existsSync(DB_PARCEIRO_DESPESAS)) {
    return {
      descricao: DEFAULT_DESCRICAO,
      atualizadoEm: new Date().toISOString().slice(0, 10),
      schemaParceiroDespesa: DEFAULT_SCHEMA,
      parceiroDespesas: [],
    };
  }
  const raw = JSON.parse(fs.readFileSync(DB_PARCEIRO_DESPESAS, "utf8")) as Record<
    string,
    unknown
  >;
  return normalizeRawDb(raw);
}

export function saveParceiroDespesasDb(db: ParceiroDespesasDb): void {
  db.atualizadoEm = new Date().toISOString().slice(0, 10);
  if (!db.descricao) db.descricao = DEFAULT_DESCRICAO;
  fs.writeFileSync(DB_PARCEIRO_DESPESAS, JSON.stringify(db, null, 2), "utf8");
}

/** @deprecated use loadParceiroDespesasDb */
export function loadDespesasDb(): ParceiroDespesasDb {
  return loadParceiroDespesasDb();
}

/** @deprecated use saveParceiroDespesasDb */
export function saveDespesasDb(db: ParceiroDespesasDb): void {
  saveParceiroDespesasDb(db);
}

export type GravarParceiroDespesaResult = {
  registro: ParceiroDespesaRegistro;
  aviso: string | null;
  acao: "novo" | "atualizado" | "sem_alteracao";
};

/** @deprecated */
export type GravarDespesaResult = GravarParceiroDespesaResult;

function despesaChanged(
  a: ParceiroDespesaRegistro,
  input: ParceiroDespesaInput,
  valor: number,
  competencia: string,
): boolean {
  return (
    a.valor !== valor ||
    a.data !== String(input.data).trim() ||
    a.descricao !== String(input.descricao).trim() ||
    a.categoria !== String(input.categoria).trim() ||
    a.competencia !== competencia
  );
}

function pickCanonicIndex(
  despesas: ParceiroDespesaRegistro[],
  indices: number[],
  origem: string,
): number {
  if (!indices.length) return -1;
  const byOrigem = indices.find((i) => despesas[i]!.origem === origem);
  if (byOrigem != null) return byOrigem;
  const prefixed = indices.find((i) => {
    const o = despesas[i]!.origem;
    return (
      o.startsWith("rastreador-fixo/") ||
      o.startsWith("detran-sc/") ||
      o.includes("Proteção Veicular/")
    );
  });
  return prefixed ?? indices[0]!;
}

function removeDuplicateIds(
  db: ParceiroDespesasDb,
  keepId: string,
  allIds: string[],
): void {
  const remove = new Set(allIds.filter((id) => id !== keepId));
  if (!remove.size) return;
  db.parceiroDespesas = db.parceiroDespesas.filter((d) => !remove.has(d.id));
}

function findMatchingIndices(
  despesas: ParceiroDespesaRegistro[],
  opts: {
    origem: string;
    placa: string;
    competencia: string;
    categoria: string;
    descricao: string;
    manual: boolean;
  },
): number[] {
  const indices: number[] = [];
  const bizKey = chaveNegocioParceiroDespesa(
    opts.placa,
    opts.competencia,
    opts.categoria,
    opts.descricao,
    opts.manual,
  );

  despesas.forEach((d, i) => {
    if (opts.origem !== "manual" && d.origem === opts.origem) {
      indices.push(i);
      return;
    }
    // A chave de negócio (placa|competência|categoria) reconcilia entradas
    // manuais com as de sync. Não deve fundir dois débitos DISTINTOS vindos de
    // sync (origens únicas por idDebito) — ex.: IPVA cota única e 1ª parcela
    // caem na mesma competência/categoria mas são alternativas a coexistir.
    if (opts.origem !== "manual" && d.origem !== "manual") return;
    const dKey = chaveNegocioParceiroDespesa(
      d.placa,
      d.competencia,
      d.categoria,
      d.descricao,
      opts.manual,
    );
    if (dKey === bizKey) indices.push(i);
  });

  return [...new Set(indices)];
}

export function sincronizarParceiroDespesa(
  input: ParceiroDespesaInput,
): GravarParceiroDespesaResult {
  const db = loadParceiroDespesasDb();
  const valor = parseValor(input.valor);
  const { id: veiculoId, placa } = resolveVeiculo(input.placa);
  const competencia = input.competencia?.trim() || competenciaFromData(input.data);
  const origem = input.origem?.trim() || "manual";
  const manual = origem === "manual";
  const descricao = String(input.descricao).trim();
  const categoria = String(input.categoria).trim();

  const matches = findMatchingIndices(db.parceiroDespesas, {
    origem,
    placa,
    competencia,
    categoria,
    descricao,
    manual,
  });

  if (matches.length) {
    const idx = pickCanonicIndex(db.parceiroDespesas, matches, origem);
    const keepId = db.parceiroDespesas[idx]!.id;
    const matchIds = matches.map((i) => db.parceiroDespesas[i]!.id);
    removeDuplicateIds(db, keepId, matchIds);
    const ex = db.parceiroDespesas.find((d) => d.id === keepId)!;
    if (!despesaChanged(ex, input, valor, competencia)) {
      return { registro: ex, aviso: null, acao: "sem_alteracao" };
    }
    ex.categoria = categoria;
    ex.descricao = descricao;
    ex.data = String(input.data).trim();
    ex.valor = valor;
    ex.competencia = competencia;
    ex.placa = placa;
    ex.veiculoId = veiculoId;
    if (origem !== "manual") ex.origem = origem;
    const exIdx = db.parceiroDespesas.findIndex((d) => d.id === keepId);
    if (exIdx >= 0) db.parceiroDespesas[exIdx] = ex;
    saveParceiroDespesasDb(db);
    return {
      registro: ex,
      aviso: veiculoId ? null : "placa não cadastrada em veiculos.json",
      acao: "atualizado",
    };
  }

  const registro: ParceiroDespesaRegistro = {
    id: crypto.randomUUID(),
    veiculoId,
    placa,
    categoria,
    descricao,
    data: String(input.data).trim(),
    valor,
    competencia,
    origem,
  };
  db.parceiroDespesas.push(registro);
  saveParceiroDespesasDb(db);
  return {
    registro,
    aviso: veiculoId ? null : "placa não cadastrada em veiculos.json",
    acao: "novo",
  };
}

/** @deprecated use sincronizarParceiroDespesa */
export function sincronizarDespesa(input: ParceiroDespesaInput): GravarParceiroDespesaResult {
  return sincronizarParceiroDespesa(input);
}

export function gravarParceiroDespesaManual(
  input: ParceiroDespesaInput,
): GravarParceiroDespesaResult {
  return sincronizarParceiroDespesa({ ...input, origem: "manual" });
}

/** @deprecated use gravarParceiroDespesaManual */
export function gravarDespesaManual(input: ParceiroDespesaInput): GravarParceiroDespesaResult {
  return gravarParceiroDespesaManual(input);
}

export type MarcarBaixaSeletor = {
  /** id da despesa (precedência sobre placa/categoria/competência). */
  id?: string;
  placa?: string;
  categoria?: string;
  competencia?: string;
};

export type MarcarBaixaResult = {
  atualizados: ParceiroDespesaRegistro[];
  semAlteracao: ParceiroDespesaRegistro[];
};

/**
 * Dá (ou desfaz) **baixa** numa ou mais despesas de parceiro. Localiza por `id`
 * ou por `placa`+`categoria`(+`competencia`). `data` vazio → quita com hoje;
 * `desfazer:true` → reabre o débito (baixa = null). Idempotente.
 */
export function marcarBaixaParceiroDespesa(
  seletor: MarcarBaixaSeletor,
  opts: { data?: string; desfazer?: boolean } = {},
): MarcarBaixaResult {
  const db = loadParceiroDespesasDb();
  const placaKey = seletor.placa ? compactPlaca(seletor.placa) : null;
  const catKey = seletor.categoria ? seletor.categoria.trim().toLowerCase() : null;
  const compKey = seletor.competencia ? seletor.competencia.trim() : null;

  const alvos = db.parceiroDespesas.filter((d) => {
    if (seletor.id) return d.id === seletor.id;
    if (placaKey && compactPlaca(d.placa) !== placaKey) return false;
    if (catKey && String(d.categoria).trim().toLowerCase() !== catKey) return false;
    if (compKey && String(d.competencia).trim() !== compKey) return false;
    return Boolean(placaKey || catKey || compKey);
  });

  const novoValor = opts.desfazer
    ? null
    : (opts.data?.trim() || new Date().toLocaleDateString("pt-BR"));

  const atualizados: ParceiroDespesaRegistro[] = [];
  const semAlteracao: ParceiroDespesaRegistro[] = [];
  for (const reg of alvos) {
    const atual = reg.baixa ?? null;
    if (atual === novoValor) {
      semAlteracao.push(reg);
      continue;
    }
    reg.baixa = novoValor;
    atualizados.push(reg);
  }
  if (atualizados.length) saveParceiroDespesasDb(db);
  return { atualizados, semAlteracao };
}

/**
 * Marca o espelho no Rastreame (tela Manutenção) de uma despesa de parceiro.
 * Grava `rastreameManutencaoId`, `rastreameHash` e `rastreameSyncEm`.
 */
export function marcarParceiroDespesaRastreameSync(
  id: string,
  fields: { manutencaoId?: string | number | null; hash?: string | null },
): void {
  const db = loadParceiroDespesasDb();
  const reg = db.parceiroDespesas.find((d) => d.id === id);
  if (!reg) return;
  if (fields.manutencaoId !== undefined) reg.rastreameManutencaoId = fields.manutencaoId;
  if (fields.hash !== undefined) reg.rastreameHash = fields.hash;
  reg.rastreameSyncEm = new Date().toISOString();
  saveParceiroDespesasDb(db);
}
