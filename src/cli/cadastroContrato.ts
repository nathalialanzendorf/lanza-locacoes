import fs from "node:fs";
import path from "node:path";

import {
  ativarClienteDoContrato,
  desativarClienteDoContrato,
} from "../lib/contratoClienteStatus.js";
import {
  encerrarContratoDb,
  excluirContrato,
  registrarContrato,
  type MotivoEncerramento,
} from "../lib/contratosDb.js";
import { gerar, type GerarContratoDados } from "../lib/docxGerar.js";
import { montarDadosContratoFromDb } from "../lib/montarDadosContrato.js";
import { REPO_ROOT } from "../lib/repoRoot.js";

function absRepo(p: string | undefined): string | undefined {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p);
}

function normalizePaths(dados: GerarContratoDados): void {
  for (const k of ["template", "contratosDir", "cnhArquivo"] as const) {
    if (dados[k]) {
      (dados as unknown as Record<string, string | undefined>)[k] = absRepo(dados[k] as string);
    }
  }
}

function printGerarResult(r: ReturnType<typeof gerar>): void {
  console.log(`Pasta -> ${r.pasta}`);
  console.log(`Word  -> ${r.docx}`);
  if (r.pdf) console.log(`PDF   -> ${r.pdf}`);
  if (r.cnh) console.log(`CNH   -> ${r.cnh}`);
  else console.log('[aviso] CNH.pdf nao copiada (informe "cnhArquivo" ou --cnh-arquivo)');
}

type GerarFlags = {
  jsonPath: string | null;
  placa: string | null;
  cpf: string | null;
  cliente: string | null;
  semana: number | null;
  caucao: number | null;
  periodo: string | null;
  dias: number | null;
  inicio: string | null;
  hora: string | null;
  diaPagamento: string | null;
  cnhArquivo: string | null;
  diaria: number | null;
  template: string | null;
  contratosDir: string | null;
  outJson: string | null;
  dryRun: boolean;
};

function parseNum(v: string, label: string): number {
  const s = v.replace(/R\$\s*/i, "").trim();
  const n = s.includes(",")
    ? parseFloat(s.replace(/\./g, "").replace(",", "."))
    : parseFloat(s);
  if (!Number.isFinite(n)) throw new Error(`${label} inválido: ${v}`);
  return Math.round(n * 100) / 100;
}

function parseGerarArgs(argv: string[]): GerarFlags {
  const flags: GerarFlags = {
    jsonPath: null,
    placa: null,
    cpf: null,
    cliente: null,
    semana: null,
    caucao: null,
    periodo: null,
    dias: null,
    inicio: null,
    hora: null,
    diaPagamento: null,
    cnhArquivo: null,
    diaria: null,
    template: null,
    contratosDir: null,
    outJson: null,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = argv[i + 1];
    switch (a) {
      case "--placa":
        flags.placa = next ?? null;
        i++;
        break;
      case "--cpf":
        flags.cpf = next ?? null;
        i++;
        break;
      case "--cliente":
        flags.cliente = next ?? null;
        i++;
        break;
      case "--semana":
        flags.semana = next ? parseNum(next, "--semana") : null;
        i++;
        break;
      case "--caucao":
        flags.caucao = next ? parseNum(next, "--caucao") : null;
        i++;
        break;
      case "--periodo":
        flags.periodo = next ?? null;
        i++;
        break;
      case "--dias":
        flags.dias = next ? parseInt(next, 10) : null;
        i++;
        break;
      case "--inicio":
        flags.inicio = next ?? null;
        i++;
        break;
      case "--hora":
        flags.hora = next ?? null;
        i++;
        break;
      case "--dia-pagamento":
        flags.diaPagamento = next ?? null;
        i++;
        break;
      case "--cnh-arquivo":
        flags.cnhArquivo = next ?? null;
        i++;
        break;
      case "--diaria":
        flags.diaria = next ? parseNum(next, "--diaria") : null;
        i++;
        break;
      case "--template":
        flags.template = next ?? null;
        i++;
        break;
      case "--contratos-dir":
        flags.contratosDir = next ?? null;
        i++;
        break;
      case "--out":
        flags.outJson = next ?? null;
        i++;
        break;
      case "--dry-run":
        flags.dryRun = true;
        break;
      default:
        if (!a.startsWith("-") && !flags.jsonPath) {
          flags.jsonPath = path.resolve(a);
        }
        break;
    }
  }
  return flags;
}

function printGerarUsage(): void {
  console.error(`Uso — gerar Word/PDF e registrar em contratos.json:
  cadastro-contrato gerar <dados.json>
  cadastro-contrato gerar --placa PLACA --cpf CPF --semana VALOR --caucao VALOR [opções]

Opções:
  --cliente "Nome"       Busca por nome (alternativa a --cpf)
  --periodo PERIODO      diaria | 1 semana | 15 dias | 3 meses | 6 meses | 1 ano
  --dias N               Sobrescreve --periodo
  --inicio DD/MM/AAAA    Padrão: hoje
  --hora HH:MM           Padrão: 18:00
  --dia-pagamento TEXTO  Padrão: todos os sábados
  --cnh-arquivo CAMINHO  Copia CNH.pdf na pasta do contrato
  --diaria VALOR         Padrão: 120
  --template CAMINHO     templates/contratos/Contrato - Modelo v3.docx
  --contratos-dir DIR    config/lanza_paths.json
  --out dados.json       Grava JSON montado (sem gerar .docx)
  --dry-run              Mostra JSON montado
`);
}

function isDbMode(f: GerarFlags): boolean {
  return Boolean(f.placa || f.cpf || f.cliente || f.semana != null || f.caucao != null);
}

async function cmdGerar(argv: string[]): Promise<void> {
  const f = parseGerarArgs(argv);

  if (f.jsonPath && isDbMode(f)) {
    console.error("[erro] Use <dados.json> OU flags --placa/--cpf, não ambos.");
    printGerarUsage();
    process.exit(1);
  }

  let dados: GerarContratoDados;

  if (f.jsonPath) {
    dados = JSON.parse(fs.readFileSync(f.jsonPath, "utf8")) as GerarContratoDados;
    normalizePaths(dados);
  } else if (f.placa && f.semana != null && f.caucao != null && (f.cpf || f.cliente)) {
    dados = montarDadosContratoFromDb({
      placa: f.placa,
      cpf: f.cpf ?? undefined,
      clienteNome: f.cliente ?? undefined,
      semana: f.semana,
      caucao: f.caucao,
      periodo: f.periodo ?? undefined,
      dias: f.dias ?? undefined,
      inicio: f.inicio ?? undefined,
      hora: f.hora ?? undefined,
      diaPagamento: f.diaPagamento ?? undefined,
      cnhArquivo: f.cnhArquivo ?? undefined,
      diaria: f.diaria ?? undefined,
      template: f.template ?? undefined,
      contratosDir: f.contratosDir ?? undefined,
    });
    normalizePaths(dados);
  } else {
    printGerarUsage();
    process.exit(1);
  }

  if (f.outJson) {
    fs.writeFileSync(path.resolve(f.outJson), JSON.stringify(dados, null, 2), "utf8");
    console.log(`JSON -> ${path.resolve(f.outJson)}`);
    if (f.dryRun) return;
  }

  if (f.dryRun) {
    console.log(JSON.stringify(dados, null, 2));
    return;
  }

  const r = gerar(dados);
  printGerarResult(r);

  let reg: ReturnType<typeof registrarContrato> | null = null;
  try {
    reg = registrarContrato(r.pasta);
    console.log(
      `Contrato registrado: v${reg.versao} | ${reg.tipoContrato} | ${reg.diaPagamentoSemana ?? reg.diaPagamentoMes ?? "—"} | database/contratos.json`,
    );
  } catch (e) {
    console.error("[aviso] Não foi possível registrar em contratos.json:", (e as Error).message);
  }

  if (reg) {
    // Cliente com contrato novo deve estar ativo (local + Rastreame): reativa se estava inativo.
    const res = await ativarClienteDoContrato({
      clienteId: reg.clienteId,
      cpf: reg.cpf,
      nome: reg.clienteNome,
    });
    if (res.local === "ativado") {
      console.log(`Cliente reativado: ${reg.clienteNome} | local + Rastreame (${res.rastreame})`);
    }
    if (res.aviso) console.error(`[aviso] ${res.aviso}`);
  }
}

function cmdSincronizar(argv: string[]): void {
  let pasta: string | null = null;
  let versao: number | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--versao" && argv[i + 1]) versao = Number(argv[++i]);
    else if (!a.startsWith("-") && !pasta) pasta = path.resolve(a);
  }

  if (!pasta) {
    console.error(`Uso:
  cadastro-contrato sincronizar <pasta-contrato> [--versao N]

Lê Contrato*.docx e grava/atualiza database/contratos.json.
`);
    process.exit(1);
  }

  const r = registrarContrato(pasta, {
    versao: versao != null && versao > 0 ? versao : undefined,
  });
  console.log(`Sincronizado: ${r.cliente.nome} | ${r.veiculo.placa} | v${r.versao} | ${r.status}`);
  console.log(`  id: ${r.id}`);
}

function parseMotivo(v: string | null): MotivoEncerramento | null {
  const t = (v ?? "").trim().toLowerCase();
  if (t === "devolvido" || t === "devolucao" || t === "devolução") return "devolvido";
  if (t === "recuperado" || t === "recolhido") return "recuperado";
  if (t === "troca" || t === "trocado") return "troca";
  return null;
}

async function cmdEncerrar(argv: string[]): Promise<void> {
  let pasta: string | null = null;
  let data: string | null = null;
  let motivo: MotivoEncerramento | null = null;
  let quebra: boolean | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if ((a === "--data" || a === "--encerramento") && argv[i + 1]) data = argv[++i]!;
    else if (a === "--motivo" && argv[i + 1]) motivo = parseMotivo(argv[++i]!);
    else if (a === "--quebra") quebra = true;
    else if (a === "--sem-quebra") quebra = false;
    else if (!a.startsWith("-") && !pasta) pasta = path.resolve(a);
  }

  if (!pasta || !data || !motivo) {
    console.error(`Uso:
  cadastro-contrato encerrar <pasta-contrato|--id uuid> \\
    --data DD/MM/AAAA --motivo devolvido|recuperado|troca [--quebra|--sem-quebra]

Efetiva encerramento em database/contratos.json (use relatorio-encerramento-contrato antes para o acerto).
"troca" não é quebra por padrão (gera novo contrato com outro veículo; caução transfere).
`);
    process.exit(1);
  }

  // "troca" não é quebra por padrão (novo contrato com outro veículo); demais motivos: quebra.
  const quebraFinal = quebra ?? (motivo === "troca" ? false : true);

  const r = encerrarContratoDb(pasta, {
    dataEncerramento: data,
    motivoEncerramento: motivo,
    quebraContrato: quebraFinal,
  });
  console.log(`Encerrado: ${r.clienteNome} | ${r.placa} | v${r.versao}`);
  console.log(`  Data: ${r.dataEncerramento} | Motivo: ${r.motivoEncerramento} | Quebra: ${r.quebraContrato ? "sim" : "não"}`);
  console.log(`  id: ${r.id}`);

  // Ao encerrar, inativa o cliente (local + Rastreame) — exceto se tiver outro contrato ativo.
  const res = await desativarClienteDoContrato({
    clienteId: r.clienteId,
    cpf: r.cpf,
    nome: r.clienteNome,
    contratoId: r.id,
  });
  if (res.local === "inativado") {
    console.log(`Cliente inativado: ${r.clienteNome} | local + Rastreame (${res.rastreame})`);
  } else if (res.aviso) {
    console.log(`Cliente mantido ativo: ${res.aviso}`);
  }
  if (res.aviso && res.rastreame === "erro") console.error(`[aviso] ${res.aviso}`);
}

function cmdExcluir(argv: string[]): void {
  let alvo: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--id" && argv[i + 1]) alvo = argv[++i]!;
    else if (!a.startsWith("-") && !alvo) alvo = path.resolve(a);
  }

  if (!alvo) {
    console.error(`Uso:
  cadastro-contrato excluir <pasta-contrato|--id uuid>

Remove o registro de database/contratos.json (não apaga a pasta Word).
`);
    process.exit(1);
  }

  const r = excluirContrato(alvo);
  console.log(`Excluído: ${r.clienteNome} | ${r.placa} | v${r.versao} | id ${r.id}`);
}

function printUsage(): void {
  console.error(`Uso: cadastro-contrato <subcomando> [args...]

Subcomandos:
  gerar          Gera .docx/.pdf e registra contrato (padrão se omitido)
  sincronizar    Importa/atualiza contratos.json a partir da pasta
  encerrar       Efetiva encerramento (data, motivo, quebra)
  excluir        Remove registro de contratos.json

Aliases legados: gerar-contrato, registrar-contrato, registrar-encerramento-contrato
`);
}

export async function main(argv: string[]): Promise<void> {
  const sub = argv[0] && !argv[0].startsWith("-") ? argv[0].toLowerCase() : null;
  const rest = sub ? argv.slice(1) : argv;

  switch (sub) {
    case "gerar":
      await cmdGerar(rest);
      break;
    case "sincronizar":
      cmdSincronizar(rest);
      break;
    case "encerrar":
      await cmdEncerrar(rest);
      break;
    case "excluir":
      cmdExcluir(rest);
      break;
    case "help":
    case "-h":
    case "--help":
      printUsage();
      printGerarUsage();
      break;
    case null:
      await cmdGerar(argv);
      break;
    default:
      if (sub.endsWith(".json") || sub.startsWith("--")) {
        await cmdGerar(argv);
      } else {
        console.error(`Subcomando desconhecido: ${sub}`);
        printUsage();
        process.exit(1);
      }
  }
}
