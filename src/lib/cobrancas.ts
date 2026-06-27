import fs from "node:fs";
import path from "node:path";

import { REPO_ROOT } from "./repoRoot.js";
import { compactPlaca, formatPlacaHyphen } from "./placa.js";
import {
  loadClienteDespesasDb,
  isInfracaoTransito,
  isClienteDespesaAtiva,
  parseRastreameIdFromAuto,
  type ClienteDespesaRegistro,
} from "./clienteDespesasDb.js";
import { inferirCondutorInfracao } from "./inferirCondutorInfracao.js";

/** Pasta com os modelos de mensagem (um arquivo .txt por cobrança). */
export const TEMPLATES_DIR = path.join(REPO_ROOT, "templates", "cobrancas");

/** Onde os textos gerados são salvos. */
export const COBRANCAS_OUT_DIR = path.join(REPO_ROOT, "relatorios", "cobrancas");

export type TipoCobranca = "semanal" | "estacionamento" | "pedagio" | "multa";

/** Dia do escalonamento semanal → arquivo de template. */
export const TEMPLATE_SEMANAL: Record<number, string> = {
  1: "semanal-1-lembrete.txt",
  2: "semanal-2-regularizacao.txt",
  3: "semanal-3-bloqueio.txt",
  4: "semanal-4-regularizado.txt",
};

const TEMPLATE_ESTACIONAMENTO = "estacionamento-rotativo.txt";
const TEMPLATE_PEDAGIO = "pedagio.txt";
const TEMPLATE_MULTA = "multa.txt";

/** Dados estruturados da cobrança (alimenta o JSON sidecar e o canvas). */
export type CobrancaDados = {
  tipo: TipoCobranca;
  placa: string;
  marcaModelo?: string;
  modeloCor?: string;
  nome?: string;
  /** semanal: dia do escalonamento (1..4). */
  dia?: number;
  /** multa: auto de infração. */
  auto?: string;
  /** multa: data de autuação (DD/MM/AAAA). */
  data?: string;
  /** multa: hora de autuação (HH:mm). */
  hora?: string;
  /** multa: cidade/UF da autuação. */
  local?: string;
  /** multa: valor da multa (R$). */
  valor?: number;
  /** multa: descrição da infração. */
  descricao?: string;
};

export type ResultadoCobranca = {
  /** Primeira linha da mensagem (assunto). */
  titulo: string;
  /** Texto pronto para colar no WhatsApp. */
  texto: string;
  /** Nome de arquivo sugerido (sem diretório). */
  nomeArquivo: string;
  /** Dados estruturados (para o canvas). */
  dados: CobrancaDados;
};

type Veiculo = {
  placa: string;
  marcaModelo?: string;
  modelo?: string;
  cor?: string;
  particular?: boolean;
};

function lerTemplate(nome: string): string {
  const p = path.join(TEMPLATES_DIR, nome);
  if (!fs.existsSync(p)) {
    throw new Error(`Template não encontrado: templates/cobrancas/${nome}`);
  }
  return fs.readFileSync(p, "utf8").replace(/\s+$/, "") + "\n";
}

function preencher(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{([A-Z_]+)\}/g, (_m, k: string) =>
    vars[k] !== undefined ? vars[k]! : `{${k}}`,
  );
}

/** Rodapé em itálico (WhatsApp) indicando envio automático. */
export const RODAPE_AUTOMATICO =
  "_Mensagem automática enviada pelo sistema Gerenciador de Locações Veiculares._";

/**
 * Preenche o template, ajusta a saudação quando não há nome ("Olá, !" → "Olá!")
 * e acrescenta o rodapé automático em itálico.
 */
function montarTexto(tpl: string, vars: Record<string, string>): string {
  const corpo = preencher(tpl, vars)
    .replace(/Olá,\s*!/g, "Olá!")
    .replace(/\s+$/, "");
  return `${corpo}\n\n${RODAPE_AUTOMATICO}\n`;
}

/** Primeiro nome, capitalizado (ex.: "CERES BEATRIZ" → "Ceres"). */
function primeiroNome(nome: string | null | undefined): string {
  const first = String(nome || "").trim().split(/\s+/)[0] ?? "";
  if (!first) return "";
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

function carregarClientesPorId(): Map<string, string> {
  const raw = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "database", "clientes.json"), "utf8"),
  ) as { clientes: { id?: string; nome?: string }[] };
  const m = new Map<string, string>();
  for (const c of raw.clientes) if (c.id && c.nome) m.set(c.id, c.nome);
  return m;
}

function hojeBr(): string {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

/** Nome do condutor da placa hoje (via contrato ativo); "" se não encontrado. */
function nomePorPlaca(placa: string): string {
  try {
    return primeiroNome(inferirCondutorInfracao(placa, hojeBr(), 90).clienteNome);
  } catch {
    return "";
  }
}

/** Nome do condutor de uma multa: condutorId da despesa, senão infere pela data. */
function nomePorMulta(d: ClienteDespesaRegistro): string {
  if (d.condutorId) {
    const nome = carregarClientesPorId().get(d.condutorId);
    if (nome) return primeiroNome(nome);
  }
  try {
    return primeiroNome(
      inferirCondutorInfracao(formatPlacaHyphen(d.veiculoId), d.dataAutuacao, 90)
        .clienteNome,
    );
  } catch {
    return "";
  }
}

function brl(v: number): string {
  return Number(v).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function carregarVeiculos(): Map<string, Veiculo> {
  const raw = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "database", "veiculos.json"), "utf8"),
  ) as { veiculos: Veiculo[] };
  return new Map(raw.veiculos.map((v) => [compactPlaca(v.placa), v]));
}

function buscarVeiculo(placa: string): Veiculo | undefined {
  return carregarVeiculos().get(compactPlaca(placa));
}

/** Veículo particular (não-locação) não gera cobrança de locatário. */
function assertVeiculoLocacao(placa: string, v: Veiculo | undefined): void {
  if (v?.particular === true) {
    throw new Error(
      `Veículo ${placa} é PARTICULAR (não-locação) — não gera cobranças de locatário.`,
    );
  }
}

function marcaModeloDe(v: Veiculo | undefined): string {
  return (v?.marcaModelo || v?.modelo || "").trim();
}

function modeloCorDe(v: Veiculo | undefined): string {
  const mm = marcaModeloDe(v);
  const cor = (v?.cor || "").trim();
  if (mm && cor) return `${mm} - ${cor}`;
  return mm || cor;
}

/** "DD/MM/AAAA HH:mm" → { data, hora }. */
function splitDataHora(s: string): { data: string; hora: string } {
  const [data = "", hora = ""] = String(s || "").trim().split(/\s+/);
  return { data, hora };
}

/** Extrai "CIDADE/UF" do final do endereço de autuação; fallback = local inteiro. */
function extrairCidadeUf(local: string): string {
  if (!local) return "";
  const m = local.match(/([A-Za-zÀ-ÿ.\s]+\/[A-Za-z]{2})\s*$/);
  return m ? m[1]!.trim() : String(local).trim();
}

function dataArquivo(): string {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getFullYear()}`;
}

function slug(s: string): string {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function gerarSemanal(
  placaRaw: string,
  dia: number,
  opts?: { nome?: string },
): ResultadoCobranca {
  const placa = formatPlacaHyphen(placaRaw);
  const v = buscarVeiculo(placa);
  assertVeiculoLocacao(placa, v);
  const nome = opts?.nome ? primeiroNome(opts.nome) : nomePorPlaca(placa);
  const nomeTpl = TEMPLATE_SEMANAL[dia] ?? TEMPLATE_SEMANAL[1]!;
  const tpl = lerTemplate(nomeTpl);
  const texto = montarTexto(tpl, {
    PLACA: placa,
    NOME: nome,
    MARCA_MODELO: marcaModeloDe(v),
  });
  return {
    titulo: texto.split("\n")[0] ?? "",
    texto,
    nomeArquivo: `cobranca-semanal-dia${dia}-${slug(placa)}-${dataArquivo()}.txt`,
    dados: { tipo: "semanal", placa, marcaModelo: marcaModeloDe(v), nome, dia },
  };
}

export function gerarEstacionamento(
  placaRaw: string,
  opts?: { nome?: string },
): ResultadoCobranca {
  const placa = formatPlacaHyphen(placaRaw);
  assertVeiculoLocacao(placa, buscarVeiculo(placa));
  const nome = opts?.nome ? primeiroNome(opts.nome) : nomePorPlaca(placa);
  const v = buscarVeiculo(placa);
  const tpl = lerTemplate(TEMPLATE_ESTACIONAMENTO);
  const texto = montarTexto(tpl, { PLACA: placa, NOME: nome });
  return {
    titulo: texto.split("\n")[0] ?? "",
    texto,
    nomeArquivo: `cobranca-estacionamento-${slug(placa)}-${dataArquivo()}.txt`,
    dados: { tipo: "estacionamento", placa, marcaModelo: marcaModeloDe(v), nome },
  };
}

export function gerarPedagio(
  placaRaw: string,
  opts?: { nome?: string },
): ResultadoCobranca {
  const placa = formatPlacaHyphen(placaRaw);
  assertVeiculoLocacao(placa, buscarVeiculo(placa));
  const nome = opts?.nome ? primeiroNome(opts.nome) : nomePorPlaca(placa);
  const v = buscarVeiculo(placa);
  const tpl = lerTemplate(TEMPLATE_PEDAGIO);
  const texto = montarTexto(tpl, { PLACA: placa, NOME: nome });
  return {
    titulo: texto.split("\n")[0] ?? "",
    texto,
    nomeArquivo: `cobranca-pedagio-${slug(placa)}-${dataArquivo()}.txt`,
    dados: { tipo: "pedagio", placa, marcaModelo: marcaModeloDe(v), nome },
  };
}

function infracoesEmAberto(
  placa: string,
  filtroAuto?: string,
): ClienteDespesaRegistro[] {
  const db = loadClienteDespesasDb();
  const alvo = compactPlaca(placa);
  const autoKey = filtroAuto?.trim().toUpperCase();
  return db.clienteDespesas.filter((d) => {
    if (!isClienteDespesaAtiva(d)) return false;
    if (!isInfracaoTransito(d)) return false;
    if (d.paga === true) return false;
    if (d.quitadaDetran === true) return false;
    if (compactPlaca(d.veiculoId) !== alvo) return false;
    // Ignora lançamentos espelhados do Rastreame (cobrança em Gastos Gerais),
    // que duplicam a multa do DETRAN sem local/hora.
    if (d.origem === "rastreame") return false;
    if (parseRastreameIdFromAuto(d.autoInfracao)) return false;
    if (autoKey && d.autoInfracao.trim().toUpperCase() !== autoKey) return false;
    return true;
  });
}

/** Uma mensagem por infração em aberto da placa (ou só a do `auto`, se informado). */
export function gerarMultas(
  placaRaw: string,
  opts?: { auto?: string; nome?: string },
): ResultadoCobranca[] {
  const placa = formatPlacaHyphen(placaRaw);
  const v = buscarVeiculo(placa);
  assertVeiculoLocacao(placa, v);
  const tpl = lerTemplate(TEMPLATE_MULTA);
  const infracoes = infracoesEmAberto(placa, opts?.auto);

  return infracoes.map((d) => {
    const { data, hora } = splitDataHora(d.dataAutuacao);
    const nome = opts?.nome ? primeiroNome(opts.nome) : nomePorMulta(d);
    const local = extrairCidadeUf(d.localInfracao || "");
    const valor = Number(d.valorMulta) || 0;
    const texto = montarTexto(tpl, {
      PLACA: placa,
      NOME: nome,
      MODELO_COR: modeloCorDe(v),
      DESCRICAO: d.descricao || "",
      DATA: data,
      HORA: hora,
      LOCAL: local,
      VALOR: brl(valor),
    });
    return {
      titulo: texto.split("\n")[0] ?? "",
      texto,
      nomeArquivo: `cobranca-multa-${slug(placa)}-${slug(
        d.autoInfracao,
      )}-${dataArquivo()}.txt`,
      dados: {
        tipo: "multa" as const,
        placa,
        modeloCor: modeloCorDe(v),
        nome,
        auto: d.autoInfracao,
        data,
        hora,
        local,
        valor,
        descricao: d.descricao || "",
      },
    };
  });
}

export function salvarCobranca(r: ResultadoCobranca, outDir?: string): string {
  const dir = outDir ?? COBRANCAS_OUT_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const saida = path.join(dir, r.nomeArquivo);
  fs.writeFileSync(saida, r.texto, "utf8");
  return saida;
}

/**
 * Grava um JSON consolidado com os dados estruturados das cobranças geradas
 * numa execução (alimenta o canvas). Retorna o caminho do arquivo.
 */
export function salvarCobrancasDados(
  resultados: ResultadoCobranca[],
  tipo: TipoCobranca,
  placaRaw: string,
  outDir?: string,
): string {
  const dir = outDir ?? COBRANCAS_OUT_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const placa = formatPlacaHyphen(placaRaw);
  const payload = {
    tipo,
    placa,
    geradoEm: new Date().toISOString(),
    cobrancas: resultados.map((r) => ({
      titulo: r.titulo,
      nomeArquivo: r.nomeArquivo,
      texto: r.texto,
      ...r.dados,
    })),
  };
  const saida = path.join(
    dir,
    `dados-${tipo}-${slug(placa)}-${dataArquivo()}.json`,
  );
  fs.writeFileSync(saida, JSON.stringify(payload, null, 2), "utf8");
  return saida;
}
