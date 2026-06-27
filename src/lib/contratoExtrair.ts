import fs from "node:fs";
import path from "node:path";

import {
  docxPlainText,
  extrairValorDiariaReais,
  extrairValorMensalReais,
  extrairValorSemanalReais,
  normalizeDocxMoneyText,
} from "./docxPlain.js";
import { formatPlacaHyphen } from "./placa.js";

export type TipoContrato = "semanal" | "diaria" | "mensal";

export type PagamentoExtraido = {
  tipoContrato: TipoContrato;
  diaPagamentoSemana: string | null;
  diaPagamentoMes: number | null;
  diaPagamentoTexto: string | null;
};

export type ContratoExtraido = {
  pastaContrato: string;
  docx: string;
  /** Número extraído do nome do ficheiro (v2 → 2); 0 se sem sufixo. */
  versaoDocumento: number;
  /** Quantos Contrato*.docx existem na pasta (renovações no mesmo diretório). */
  totalDocumentosContrato: number;
  clienteNome: string;
  placa: string;
  cpf: string | null;
  inicio: Date;
  fim: Date;
  prazoDias: number;
  tipoContrato: TipoContrato;
  diaPagamentoSemana: string | null;
  diaPagamentoMes: number | null;
  diaPagamentoTexto: string | null;
  valorSemanal: number | null;
  valorMensal: number | null;
  valorDiaria: number | null;
  valorCaucao: number;
};

export type ExtrairContratoOpts = {
  /** Exige período no Word quando há renovações (v2+) na mesma pasta. */
  paraEncerramento?: boolean;
};

function brMoneyToNumber(s: string): number | null {
  const m = s.match(/R\$\s*([\d.,]+)/i);
  if (!m) return null;
  const raw = m[1]!.replace(/\./g, "").replace(",", ".");
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export function parseDataBr(s: string): Date | null {
  const t = String(s || "").trim();
  const m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
  if (!m) return null;
  const h = m[4] !== undefined ? Number(m[4]) : 12;
  const min = m[5] !== undefined ? Number(m[5]) : 0;
  const dt = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), h, min, 0);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function parseDataPasta(nomePasta: string): Date | null {
  const m4 = nomePasta.match(/^(\d{2})\.(\d{2})\.(\d{4})\s*-\s*/);
  if (m4) {
    const dt = new Date(Number(m4[3]), Number(m4[2]) - 1, Number(m4[1]), 12, 0, 0);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  const m2 = nomePasta.match(/^(\d{2})\.(\d{2})\.(\d{2})(?!\d)\s*-\s*/);
  if (m2) {
    const yy = Number(m2[3]);
    const y = yy >= 50 ? 1900 + yy : 2000 + yy;
    const dt = new Date(y, Number(m2[2]) - 1, Number(m2[1]), 12, 0, 0);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  return null;
}

function clienteDaPasta(nomePasta: string): string | null {
  const m = nomePasta.match(/^\d{2}\.\d{2}\.\d{2,4}\s*-\s*(.+)$/);
  return m ? m[1]!.trim() : null;
}

function extrairPlaca(texto: string): string | null {
  const t = texto.normalize("NFD").replace(/\p{M}/gu, "");
  const m = t.match(/placa:\s*([A-Z0-9-\s]+)/i);
  if (!m) return null;
  const raw = m[1]!.replace(/\s+/g, "").replace(/[^A-Z0-9]/gi, "").slice(0, 7);
  return raw.length >= 3 ? formatPlacaHyphen(raw) : null;
}

function extrairCpf(texto: string): string | null {
  const m = texto.match(/CPF sob o n[°º]\s*([\d.\-]+)/i);
  return m ? m[1]!.trim() : null;
}

export type LocatarioExtraido = {
  nome: string;
  cpf: string;
  endereco: {
    logradouro: string;
    numero: string;
    complemento: string;
    bairro: string;
    cidade: string;
    uf: string;
    cep: string;
  };
};

const ESTADO_UF: Record<string, string> = {
  "Santa Catarina": "SC",
  "São Paulo": "SP",
  "Rio Grande do Sul": "RS",
  "Paraná": "PR",
  "Rio de Janeiro": "RJ",
  "Minas Gerais": "MG",
};

function estadoParaUf(estado: string): string {
  const e = estado.trim();
  if (/^[A-Z]{2}$/.test(e)) return e;
  return ESTADO_UF[e] ?? e;
}

/** Extrai bloco LOCATÁRIO do texto do contrato Word. */
export function extrairLocatarioDocx(texto: string): LocatarioExtraido | null {
  const flat = texto.replace(/\s+/g, " ").trim();
  const m = flat.match(
    /LOCATÁRIO\(a\):\s*([^,]+?)\s*,\s*inscrito no CPF sob o n[°º]\s*([\d.\-]+)\s*,\s*residente e domiciliado na\s*(.+?)\s*,\s*bairro\s*(.+?)\s*,\s*cidade\s*(.+?)\s*,\s*estado\s*(.+?)\s*,\s*CEP\s*([\d.\-]+)/i,
  );
  if (!m) return null;
  const log = m[3]!.trim();
  const numMatch = log.match(/^(.+?),\s*n[°º]?\s*(.+)$/i);
  let logradouro = log;
  let numero = "";
  if (numMatch) {
    logradouro = numMatch[1]!.trim();
    numero = numMatch[2]!.trim();
  }
  return {
    nome: m[1]!.trim(),
    cpf: m[2]!.trim(),
    endereco: {
      logradouro,
      numero,
      complemento: "",
      bairro: m[4]!.trim(),
      cidade: m[5]!.trim(),
      uf: estadoParaUf(m[6]!.trim()),
      cep: m[7]!.trim(),
    },
  };
}

function extrairPrazoDias(texto: string): number | null {
  const t = texto.normalize("NFD").replace(/\p{M}/gu, "");
  const m = t.match(/lapso temporal de validade de\s+(\d+)\s+dias/i);
  return m ? Number(m[1]) : null;
}

function extrairPeriodo(
  texto: string,
  inicioPasta: Date,
  prazoDias: number,
): { inicio: Date; fim: Date; extraidoDoDocx: boolean } {
  const t = normalizeDocxMoneyText(texto.normalize("NFD").replace(/\p{M}/gu, ""));
  const m = t.match(
    /iniciando no dia\s+(\d{2}\s*\/\s*\d{2}\s*\/\s*\d{4})[^e]+e terminando no dia\s+(\d{2}\s*\/\s*\d{2}\s*\/\s*\d{4})/i,
  );
  if (m) {
    const ini = parseDataBr(m[1]!.replace(/\s/g, ""));
    const fim = parseDataBr(m[2]!.replace(/\s/g, ""));
    if (ini && fim) return { inicio: ini, fim, extraidoDoDocx: true };
  }
  const fim = new Date(inicioPasta);
  fim.setDate(fim.getDate() + prazoDias);
  return { inicio: inicioPasta, fim, extraidoDoDocx: false };
}

function extrairCaucao(texto: string, valorSemanal: number): number {
  const t = normalizeDocxMoneyText(texto.normalize("NFD").replace(/\p{M}/gu, ""));
  const patterns = [
    /cau[cç][aã]o[\s\S]{0,120}?(R\$\s*[\d.,]+)/i,
    /valor\s+ca[\s\S]{0,40}?u[cç][aã]o[\s\S]{0,80}?(R\$\s*[\d.,]+)/i,
    /3\.3[\s\S]{0,180}?(R\$\s*[\d.,]+)/i,
    /(R\$\s*[\d.,]+)[\s\S]{0,80}?cau[cç][aã]o/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) {
      const n = brMoneyToNumber(m[1]!);
      if (n !== null && n > 0) return n;
    }
  }
  return Math.round(valorSemanal * 2.31 * 100) / 100;
}

const DIAS_SEMANA: { key: string; re: RegExp }[] = [
  { key: "segunda", re: /segundas?\s*-?\s*feiras?/i },
  { key: "terca", re: /ter[cç]as?\s*-?\s*feiras?/i },
  { key: "quarta", re: /quartas?\s*-?\s*feiras?/i },
  { key: "quinta", re: /quintas?\s*-?\s*feiras?/i },
  { key: "sexta", re: /sextas?\s*-?\s*feiras?/i },
  { key: "sabado", re: /s[aá]bados?/i },
  { key: "domingo", re: /domingos?/i },
];

function blocoPagamentoLocacao(texto: string): string {
  const flat = texto.replace(/\s+/g, " ").trim();
  const cl3 = flat.match(/Cl[aá]usula\s+3[^\d]*DO\s+PAGAMENTO[\s\S]{0,900}/i);
  if (cl3) return cl3[0]!;

  const idx = flat.search(
    /pagamento da loca(?:c|ç)[aã]o|realizado\s+semanalmente|realizado\s+mensalmente|realizado\s+diariamente/i,
  );
  if (idx >= 0) return flat.slice(idx, idx + 450);

  const cl32 = flat.match(/3\.2[\s\S]{0,450}/i);
  return cl32?.[0] ?? flat;
}

function normalizarDiaSemana(raw: string): string | null {
  const t = raw
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/-feiras?$/i, "")
    .trim();
  for (const { key, re } of DIAS_SEMANA) {
    if (re.test(t) || t.startsWith(key.slice(0, 4))) return key;
  }
  return null;
}

/** Extrai tipo de contrato e dia de pagamento (cláusula 3.2). */
export function extrairPagamento(texto: string): PagamentoExtraido {
  const cl32 = blocoPagamentoLocacao(texto);
  const t = cl32.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

  let tipoContrato: TipoContrato = "semanal";
  if (/mensalmente|por mes\b|ao mes\b|locacao mensal|locação mensal/i.test(t)) {
    tipoContrato = "mensal";
  } else if (/diariamente|por dia\b|locacao diaria|locação diária/i.test(t)) {
    tipoContrato = "diaria";
  } else if (/semanalmente|por semana\b|locacao semanal|locação semanal/i.test(t)) {
    tipoContrato = "semanal";
  }

  let diaPagamentoSemana: string | null = null;
  let diaPagamentoMes: number | null = null;
  let diaPagamentoTexto: string | null = null;

  if (tipoContrato === "mensal") {
    const dm =
      t.match(/(?:todo|toda)\s+dia\s+(\d{1,2})/i) ??
      t.match(/dia\s+(\d{1,2})\s+de\s+cada/i) ??
      t.match(/dia\s+(\d{1,2})\b/i);
    if (dm) {
      const n = Number(dm[1]);
      if (n >= 1 && n <= 31) diaPagamentoMes = n;
    }
    const tm = cl32.match(/(?:todo|toda)\s+dia\s+\d{1,2}/i) ?? cl32.match(/dia\s+\d{1,2}/i);
    if (tm) diaPagamentoTexto = tm[0]!.trim();
  } else if (tipoContrato === "semanal") {
    for (const { key, re } of DIAS_SEMANA) {
      if (re.test(t)) {
        diaPagamentoSemana = key;
        const tm = cl32.match(re);
        if (tm) diaPagamentoTexto = tm[0]!.trim();
        break;
      }
    }
    if (!diaPagamentoSemana) {
      const todas = t.match(/todas?\s+as?\s+(\w+(?:\s*-?\s*feiras?)?)/i);
      if (todas) {
        diaPagamentoSemana = normalizarDiaSemana(todas[1]!);
        diaPagamentoTexto = todas[0]!.trim();
      }
    }
    if (!diaPagamentoSemana) {
      const todos = t.match(/todos?\s+os?\s+(\w+(?:\s*-?\s*feiras?)?)/i);
      if (todos) {
        diaPagamentoSemana = normalizarDiaSemana(todos[1]!);
        diaPagamentoTexto = todos[0]!.trim();
      }
    }
  }

  return { tipoContrato, diaPagamentoSemana, diaPagamentoMes, diaPagamentoTexto };
}

function versaoDocxFilename(nome: string): number {
  const vm = nome.match(/\bv(\d+)\b/i);
  return vm ? Number(vm[1]) : 0;
}

function listContratoDocxOrdenados(pastaContrato: string): { f: string; version: number; mtime: number }[] {
  const ents = fs.readdirSync(pastaContrato);
  const docxs = ents.filter((f) => /^Contrato.*\.docx$/i.test(f));
  return docxs
    .map((f) => {
      const version = versaoDocxFilename(f);
      const mtime = fs.statSync(path.join(pastaContrato, f)).mtimeMs;
      return { f, version, mtime };
    })
    .sort((a, b) => b.version - a.version || b.mtime - a.mtime);
}

function findContratoDocx(pastaContrato: string): string {
  const scored = listContratoDocxOrdenados(pastaContrato);
  if (scored.length === 0) {
    throw new Error(`Contrato*.docx não encontrado em ${pastaContrato}`);
  }
  return path.join(pastaContrato, scored[0]!.f);
}

export function resolverPastaContrato(input: string): string {
  const abs = path.resolve(input);
  if (fs.statSync(abs).isFile()) {
    return path.dirname(abs);
  }
  if (/^Contrato.*\.docx$/i.test(path.basename(abs))) {
    return path.dirname(abs);
  }
  return abs;
}

export function extrairContrato(
  pastaOuDocx: string,
  opts: ExtrairContratoOpts = {},
): ContratoExtraido {
  const pastaContrato = resolverPastaContrato(pastaOuDocx);
  const docxsOrdenados = listContratoDocxOrdenados(pastaContrato);
  const docx = path.join(pastaContrato, docxsOrdenados[0]!.f);
  const versaoDocumento = docxsOrdenados[0]!.version;
  const totalDocumentosContrato = docxsOrdenados.length;
  const nomePasta = path.basename(pastaContrato);
  const inicioPasta = parseDataPasta(nomePasta);
  const clienteNome = clienteDaPasta(nomePasta);
  if (!inicioPasta || !clienteNome) {
    throw new Error(`Pasta de contrato inválida (esperado DD.MM.AAAA - Nome): ${nomePasta}`);
  }

  const texto = docxPlainText(docx);
  const placa = extrairPlaca(texto);
  if (!placa) throw new Error(`Placa não encontrada no contrato: ${docx}`);

  const pagamento = extrairPagamento(texto);
  const valorSemanal = extrairValorSemanalReais(texto);
  const valorMensal = extrairValorMensalReais(texto);
  const valorDiariaDoc = extrairValorDiariaReais(texto);

  const valorBase =
    pagamento.tipoContrato === "mensal"
      ? valorMensal
      : pagamento.tipoContrato === "diaria"
        ? valorDiariaDoc
        : valorSemanal;

  if (valorBase == null || valorBase <= 0) {
    throw new Error(`Valor da locação não encontrado no contrato (${pagamento.tipoContrato}): ${docx}`);
  }

  const prazoDias = extrairPrazoDias(texto) ?? 90;
  let periodo = extrairPeriodo(texto, inicioPasta, prazoDias);
  if (opts.paraEncerramento && totalDocumentosContrato > 1 && !periodo.extraidoDoDocx) {
    for (const alt of docxsOrdenados.slice(1)) {
      const textoAlt = docxPlainText(path.join(pastaContrato, alt.f));
      const prazoAlt = extrairPrazoDias(textoAlt) ?? prazoDias;
      const pAlt = extrairPeriodo(textoAlt, inicioPasta, prazoAlt);
      if (pAlt.extraidoDoDocx) {
        periodo = pAlt;
        break;
      }
    }
  }
  if (opts.paraEncerramento && totalDocumentosContrato > 1 && !periodo.extraidoDoDocx) {
    throw new Error(
      `Há ${totalDocumentosContrato} versões do contrato nesta pasta; o relatório de quebra usa só a mais recente (${path.basename(docx)}). ` +
        `O período (início/fim) não foi encontrado nesse documento — corrija a cláusula 1.2 no Word antes de gerar o relatório.`,
    );
  }
  const { inicio, fim } = periodo;
  const refSemanal = valorSemanal ?? (valorMensal ? valorMensal / 4.33 : valorBase);
  const valorCaucao = extrairCaucao(texto, refSemanal);

  const valorDiaria =
    valorDiariaDoc ??
    (valorSemanal != null ? Math.round((valorSemanal / 7) * 100) / 100 : null);

  return {
    pastaContrato,
    docx,
    versaoDocumento,
    totalDocumentosContrato,
    clienteNome,
    placa,
    cpf: extrairCpf(texto),
    inicio,
    fim,
    prazoDias,
    tipoContrato: pagamento.tipoContrato,
    diaPagamentoSemana: pagamento.diaPagamentoSemana,
    diaPagamentoMes: pagamento.diaPagamentoMes,
    diaPagamentoTexto: pagamento.diaPagamentoTexto,
    valorSemanal,
    valorMensal,
    valorDiaria,
    valorCaucao,
  };
}

export function fmtDataBr(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0);
}

export function daysBetween(a: Date, b: Date): number {
  const ms = startOfDay(b).getTime() - startOfDay(a).getTime();
  return Math.max(0, Math.round(ms / 86400000));
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Valor de cada parcela conforme o tipo de contrato. */
export function valorParcelaContrato(c: ContratoExtraido): number {
  if (c.tipoContrato === "mensal" && c.valorMensal != null) return c.valorMensal;
  if (c.tipoContrato === "diaria" && c.valorDiaria != null) return c.valorDiaria;
  if (c.valorSemanal != null) return c.valorSemanal;
  throw new Error("Valor da locação não definido no contrato.");
}

/** Valor diário para cálculo de atraso. */
export function valorDiariaContrato(c: ContratoExtraido): number {
  if (c.valorDiaria != null) return c.valorDiaria;
  if (c.valorSemanal != null) return Math.round((c.valorSemanal / 7) * 100) / 100;
  if (c.valorMensal != null) return Math.round((c.valorMensal / 30) * 100) / 100;
  throw new Error("Valor diário não definido no contrato.");
}

/** Intervalo entre vencimentos (dias). */
export function intervaloPagamentoDias(c: ContratoExtraido): number {
  if (c.tipoContrato === "mensal") return 30;
  if (c.tipoContrato === "diaria") return 1;
  return 7;
}
