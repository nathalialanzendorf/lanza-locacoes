import fs from "node:fs";
import path from "node:path";

import { fmtDataBr } from "./contratoExtrair.js";
import { defaultContratosDir } from "./lanzaPaths.js";
import { formatPlacaHyphen, placasIguais } from "./placa.js";
import { REPO_ROOT } from "./repoRoot.js";
import type { GerarContratoDados } from "./docxGerar.js";

const DB_CLIENTES = path.join(REPO_ROOT, "database", "clientes.json");
const DB_VEICULOS = path.join(REPO_ROOT, "database", "veiculos.json");
const DEFAULT_TEMPLATE = path.join(
  REPO_ROOT,
  "templates",
  "contratos",
  "Contrato - Modelo v3.docx",
);

export type ClienteDb = {
  id?: string;
  nome: string;
  cpf: string;
  endereco?: {
    cep?: string | null;
    logradouro?: string | null;
    numero?: string | null;
    complemento?: string | null;
    bairro?: string | null;
    cidade?: string | null;
    uf?: string | null;
  };
  cnh?: { categoria?: string | null };
};

export type VeiculoDb = {
  placa: string;
  marcaModelo?: string;
  fipeModelo?: string;
  chassi?: string;
  renavam?: string;
  anoModelo?: string;
  cor?: string;
  fipe?: string;
  fipeValor?: string;
  /**
   * Pasta do veículo em "Aluguel Carros" onde ficam os contratos (ex.:
   * "Felipe - FORD FOCUS 2013-2014"). Aceita nome relativo (resolvido sob
   * defaultContratosDir()) ou caminho absoluto. Quando presente, os contratos
   * são gerados DENTRO desta pasta.
   */
  pastaVeiculo?: string;
};

export type MontarContratoDbInput = {
  placa: string;
  cpf?: string;
  /** Busca parcial por nome (use --cpf se houver ambiguidade). */
  clienteNome?: string;
  semana: number;
  caucao: number;
  periodo?: string;
  dias?: number;
  inicio?: string;
  hora?: string;
  diaPagamento?: string;
  cnhArquivo?: string;
  diaria?: number;
  template?: string;
  contratosDir?: string;
  assinatura?: { cidade?: string; estado?: string; data?: string };
};

const PERIODO_DIAS: Record<string, number> = {
  diaria: 1,
  "1 semana": 7,
  semana: 7,
  "15 dias": 15,
  "3 meses": 90,
  "6 meses": 180,
  "1 ano": 365,
  ano: 365,
};

function normNome(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normCpfDigits(cpf: string | null | undefined): string {
  return (cpf ?? "").replace(/\D/g, "");
}

function strField(v: unknown): string {
  if (v == null) return "";
  return String(v).trim();
}

export function loadClientesDb(): ClienteDb[] {
  if (!fs.existsSync(DB_CLIENTES)) return [];
  const j = JSON.parse(fs.readFileSync(DB_CLIENTES, "utf8")) as { clientes?: ClienteDb[] };
  return j.clientes ?? [];
}

export function loadVeiculosDb(): VeiculoDb[] {
  if (!fs.existsSync(DB_VEICULOS)) return [];
  const j = JSON.parse(fs.readFileSync(DB_VEICULOS, "utf8")) as { veiculos?: VeiculoDb[] };
  return j.veiculos ?? [];
}

export function findClienteDb(cpf?: string, nome?: string): ClienteDb {
  const list = loadClientesDb();
  if (list.length === 0) {
    throw new Error("database/clientes.json vazio — use cadastro-cliente antes de gerar o contrato.");
  }

  if (cpf) {
    const key = normCpfDigits(cpf);
    const c = list.find((x) => normCpfDigits(x.cpf) === key);
    if (!c) {
      throw new Error(
        `Cliente com CPF ${cpf} não encontrado em clientes.json — use cadastro-cliente.`,
      );
    }
    return c;
  }

  if (nome) {
    const n = normNome(nome);
    const matches = list.filter((x) => {
      const xn = normNome(x.nome);
      return xn.includes(n) || n.includes(xn);
    });
    if (matches.length === 0) {
      throw new Error(
        `Cliente "${nome}" não encontrado em clientes.json — use cadastro-cliente ou informe --cpf.`,
      );
    }
    if (matches.length > 1) {
      throw new Error(
        `Vários clientes para "${nome}": ${matches.map((m) => `${m.nome} (${m.cpf})`).join("; ")} — use --cpf.`,
      );
    }
    return matches[0]!;
  }

  throw new Error("Informe --cpf ou --cliente (nome do locatário).");
}

export function findVeiculoDb(placa: string): VeiculoDb {
  const list = loadVeiculosDb();
  const v = list.find((x) => placasIguais(x.placa, placa));
  if (!v) {
    throw new Error(
      `Placa ${formatPlacaHyphen(placa)} não encontrada em veiculos.json — use cadastro-veiculo.`,
    );
  }
  return v;
}

/**
 * Resolve o diretório onde o contrato será gerado.
 * Prioridade: --contratos-dir explícito > pastaVeiculo do veículo > raiz padrão.
 * `pastaVeiculo` pode ser nome relativo (sob a raiz) ou caminho absoluto.
 */
export function resolverContratosDir(veiculo: VeiculoDb, contratosDirInput?: string): string {
  if (contratosDirInput && contratosDirInput.trim()) return contratosDirInput;
  const pasta = strField(veiculo.pastaVeiculo);
  if (pasta) {
    return path.isAbsolute(pasta) ? pasta : path.join(defaultContratosDir(), pasta);
  }
  return defaultContratosDir();
}

export function periodoParaDias(periodo?: string, dias?: number): number {
  if (dias != null && Number.isFinite(dias) && dias > 0) return Math.round(dias);
  if (!periodo) return 90;
  const key = periodo.trim().toLowerCase();
  const d = PERIODO_DIAS[key];
  if (d) return d;
  const n = parseInt(key, 10);
  if (Number.isFinite(n) && n > 0) return n;
  throw new Error(
    `Período inválido: "${periodo}". Use: diaria, 1 semana, 15 dias, 3 meses, 6 meses, 1 ano ou --dias N.`,
  );
}

function validarEnderecoCliente(c: ClienteDb): void {
  const e = c.endereco ?? {};
  const faltando: string[] = [];
  if (!strField(e.logradouro)) faltando.push("logradouro");
  if (!strField(e.bairro)) faltando.push("bairro");
  if (!strField(e.cidade)) faltando.push("cidade");
  if (!strField(e.uf)) faltando.push("uf");
  if (faltando.length > 0) {
    throw new Error(
      `Endereço incompleto para ${c.nome} em clientes.json (${faltando.join(", ")}) — atualize via cadastro-cliente.`,
    );
  }
}

function mapVeiculo(v: VeiculoDb): Record<string, string> {
  return {
    placa: formatPlacaHyphen(v.placa),
    marcaModelo: strField(v.marcaModelo),
    fipeModelo: strField(v.fipeModelo),
    chassi: strField(v.chassi),
    renavam: strField(v.renavam),
    anoModelo: strField(v.anoModelo),
    cor: strField(v.cor),
    fipe: strField(v.fipe || v.fipeValor),
  };
}

export function montarDadosContratoFromDb(input: MontarContratoDbInput): GerarContratoDados {
  const cliente = findClienteDb(input.cpf, input.clienteNome);
  validarEnderecoCliente(cliente);
  const veiculo = findVeiculoDb(input.placa);

  const end = cliente.endereco ?? {};
  const inicio = input.inicio?.trim() || fmtDataBr(new Date());
  const dias = periodoParaDias(input.periodo, input.dias);

  return {
    template: input.template ?? DEFAULT_TEMPLATE,
    contratosDir: resolverContratosDir(veiculo, input.contratosDir),
    cnhArquivo: input.cnhArquivo,
    diaPagamento: input.diaPagamento ?? "todos os sábados",
    cliente: {
      nome: cliente.nome,
      cpf: cliente.cpf,
      endereco: {
        logradouro: strField(end.logradouro),
        numero: strField(end.numero),
        complemento: strField(end.complemento),
        bairro: strField(end.bairro),
        cidade: strField(end.cidade),
        uf: strField(end.uf),
        cep: strField(end.cep),
      },
    },
    veiculo: mapVeiculo(veiculo),
    prazo: {
      dias,
      inicio,
      hora: input.hora ?? "18:00",
    },
    valores: {
      semana: input.semana,
      caucao: input.caucao,
      diaria: input.diaria ?? 120,
    },
    cnhCategoria: strField(cliente.cnh?.categoria) || "B",
    assinatura: input.assinatura ?? {
      cidade: "Tubarão",
      estado: "Santa Catarina",
      data: "auto",
    },
  };
}
