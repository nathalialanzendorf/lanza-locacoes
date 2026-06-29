import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { REPO_ROOT } from "../lib/repoRoot.js";
import { executarTriagem, type FonteId } from "../lib/triagem/index.js";
import {
  caminhoBase,
  gravarRelatorio,
  montarRelatorio,
  type DadosLgpd,
} from "../lib/triagem/relatorio.js";
import { listarTriagens, registrarTriagem } from "../lib/triagem/triagemDb.js";
import type { DadosLocatario, ResultadoFonte } from "../lib/triagem/tipos.js";

/**
 * Triagem de locatário — antecedentes criminais / processos em fontes públicas
 * gratuitas (CNJ BNMP, PF SINIC, TJSC), via Chrome real (o operador resolve
 * captcha/login). Antecedentes são dados sensíveis de terceiros: é OBRIGATÓRIO
 * registrar a base legal (LGPD) antes de rodar.
 */

const HELP = `triagem-locatario --cpf CPF --nome "NOME" --nascimento DD/MM/AAAA --base-legal "TEXTO" [opções]

  Triagem de antecedentes criminais / processos de um locatário a partir de
  fontes públicas gratuitas. Antecedentes são dados sensíveis de terceiros:
  é OBRIGATÓRIO registrar a base legal (LGPD) antes de rodar.

  Obrigatórios:
    --cpf CPF                  CPF do locatário (com ou sem pontuação)
    --nome "NOME COMPLETO"     Nome civil completo
    --nascimento DD/MM/AAAA    Data de nascimento
    --base-legal "TEXTO"       Base legal LGPD (ex.: "consentimento do locatário")

  Fontes (default: todas):
    --bnmp                     Só CNJ BNMP (mandados/procurados, por nome)
    --pf                       Só PF SINIC (antecedentes nacionais, por CPF)
    --tjsc                     Só TJSC (certidão criminal estadual — assistido)
    (combináveis; sem nenhuma destas, roda as três)

  Opcionais:
    --mae "NOME"               Nome da mãe (filiação) — a PF usa p/ refinar
    --pai "NOME"               Nome do pai (filiação)
    --uf-nascimento UF         UF de nascimento (ex.: SC)
    --municipio-nascimento M   Município de nascimento (ex.: Imbituba)
    --email-resposta EMAIL     TJSC: e-mail que recebe a certidão (requisição)
    --finalidade "TEXTO"       TJSC: finalidade da requisição (default locação)
    --titular "NOME"           Quem consentiu (default: o próprio locatário)
    --solicitante "NOME"       Operador que faz a triagem
    --timeout-min N            Minutos de espera por fonte (default 6)
    --sem-browser              Não abre o Chrome; gera só o relatório-esqueleto
    --out CAMINHO              Base de saída (default: relatorios/triagem/<cpf>-<data>)
    --json                     Imprime o relatório (JSON) no stdout
    -h, --help                 Mostra esta ajuda

  Histórico (database/triagem.json):
    --listar [--cpf CPF] [--com-alerta] [--json]
                               Lista triagens já gravadas (não consulta nada)

Exemplo:
  npx tsx src/run.ts triagem-locatario \\
    --cpf 123.456.789-09 --nome "Fulano de Tal" --nascimento 31/12/1990 \\
    --base-legal "consentimento do locatário" --titular "Fulano de Tal"

Saída:
  relatorios/triagem/<cpf>-<AAAA-MM-DD>.json  (estruturado)
  relatorios/triagem/<cpf>-<AAAA-MM-DD>.md    (resumo legível)`;

function opt(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function cpfDigits(cpf: string): string {
  return String(cpf ?? "").replace(/\D/g, "");
}

function cpfValido(cpf: string): boolean {
  const d = cpfDigits(cpf);
  if (d.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(d)) return false;
  const calc = (base: string, pesoInicial: number): number => {
    let soma = 0;
    for (let i = 0; i < base.length; i++) soma += Number(base[i]) * (pesoInicial - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  const dv1 = calc(d.slice(0, 9), 10);
  const dv2 = calc(d.slice(0, 10), 11);
  return dv1 === Number(d[9]) && dv2 === Number(d[10]);
}

function cpfFormatado(cpf: string): string {
  const d = cpfDigits(cpf);
  return d.length === 11
    ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`
    : cpf;
}

function dataValida(s: string): boolean {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s ?? "").trim());
  if (!m) return false;
  const dia = Number(m[1]);
  const mes = Number(m[2]);
  const ano = Number(m[3]);
  const dt = new Date(ano, mes - 1, dia);
  if (dt.getFullYear() !== ano || dt.getMonth() !== mes - 1 || dt.getDate() !== dia) {
    return false;
  }
  if (dt.getTime() > Date.now()) return false;
  if (ano < 1900) return false;
  return true;
}

function fontesSelecionadas(argv: string[]): FonteId[] {
  const sel: FonteId[] = [];
  if (argv.includes("--bnmp")) sel.push("bnmp");
  if (argv.includes("--pf")) sel.push("pf");
  if (argv.includes("--tjsc")) sel.push("tjsc");
  return sel.length ? sel : ["bnmp", "pf", "tjsc"];
}

function aguardarEnter(msg: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(msg, () => {
      rl.close();
      resolve();
    });
  });
}

/** Arquivo-sinalizador para encerrar o passo assistido do TJSC em background. */
const TJSC_FLAG = path.join(REPO_ROOT, "relatorios", "_tmp", "triagem", "tjsc-done.flag");

/**
 * Espera o fim do passo assistido do TJSC antes de fechar o Chrome.
 * - Terminal interativo (TTY): pede Enter ao operador.
 * - Em background (sem TTY): aguarda o arquivo-sinalizador `TJSC_FLAG` (que o
 *   operador/assistente cria ao terminar) ou um timeout, para não travar.
 */
function aguardarFimTjsc(timeoutMin: number): Promise<void> {
  if (process.stdin.isTTY) {
    return aguardarEnter("\nConcluiu o passo do TJSC? Pressione Enter para fechar o Chrome...");
  }
  try {
    fs.mkdirSync(path.dirname(TJSC_FLAG), { recursive: true });
    fs.rmSync(TJSC_FLAG, { force: true });
  } catch {
    /* best-effort */
  }
  console.log(
    `\n[background] TJSC assistido: faça o login gov.br + requisição. Ao terminar, crie o arquivo:\n  ${TJSC_FLAG}\n(ou aguarde até ${timeoutMin} min para fechar automaticamente).`,
  );
  const deadline = Date.now() + Math.max(1, timeoutMin) * 60 * 1000;
  return new Promise((resolve) => {
    const t = setInterval(() => {
      if (fs.existsSync(TJSC_FLAG) || Date.now() > deadline) {
        clearInterval(t);
        try {
          fs.rmSync(TJSC_FLAG, { force: true });
        } catch {
          /* best-effort */
        }
        resolve();
      }
    }, 1500);
  });
}

/**
 * Mescla as fontes recém-consultadas com as do relatório do MESMO dia (se houver):
 * fontes novas substituem as de mesmo `id`; as não reexecutadas são preservadas.
 * Permite rodar só `--pf`/`--tjsc` depois sem perder o BNMP já capturado.
 */
function mesclarFontes(base: string, novas: ResultadoFonte[]): ResultadoFonte[] {
  let anteriores: ResultadoFonte[] = [];
  const arq = `${base}.json`;
  try {
    if (fs.existsSync(arq)) {
      const r = JSON.parse(fs.readFileSync(arq, "utf8")) as { fontes?: ResultadoFonte[] };
      if (Array.isArray(r.fontes)) anteriores = r.fontes;
    }
  } catch {
    /* relatório anterior ilegível — ignora e usa só as novas */
  }
  const porId = new Map<string, ResultadoFonte>();
  for (const f of anteriores) porId.set(f.id, f);
  for (const f of novas) porId.set(f.id, f);
  const ordem = ["bnmp", "pf-sinic", "tjsc"];
  return [...porId.values()].sort(
    (a, b) =>
      (ordem.indexOf(a.id) + 1 || 99) - (ordem.indexOf(b.id) + 1 || 99),
  );
}

/** Esqueleto: fontes como "pendente" (modo --sem-browser). */
function fontesPendentes(): ResultadoFonte[] {
  const agora = new Date().toISOString();
  return [
    {
      id: "bnmp",
      nome: "CNJ BNMP — mandados de prisão / procurados",
      status: "pendente",
      alerta: false,
      observacao: "Não consultado (--sem-browser).",
      achados: [],
      consultadoEm: agora,
    },
    {
      id: "pf-sinic",
      nome: "PF SINIC — certidão de antecedentes criminais (nacional)",
      status: "pendente",
      alerta: false,
      observacao: "Não consultado (--sem-browser).",
      achados: [],
      evidencia: null,
      consultadoEm: agora,
    },
    {
      id: "tjsc",
      nome: "TJSC — certidão criminal estadual (eproc)",
      status: "pendente",
      alerta: false,
      observacao: "Não consultado (--sem-browser).",
      achados: [],
      consultadoEm: agora,
    },
  ];
}

export async function main(argv: string[]): Promise<void> {
  if (!argv.length || argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    return;
  }

  // Consulta do histórico gravado (não roda triagem, não exige base legal).
  if (argv.includes("--listar")) {
    const registros = listarTriagens({
      cpf: opt(argv, "--cpf") ?? undefined,
      comAlerta: argv.includes("--com-alerta"),
    });
    if (argv.includes("--json")) {
      console.log(JSON.stringify(registros, null, 2));
      return;
    }
    if (!registros.length) {
      console.log("Nenhuma triagem no histórico (database/triagem.json).");
      return;
    }
    console.log(`Histórico de triagens (${registros.length}):\n`);
    for (const t of registros) {
      const tag = t.alertaGeral ? "ATENÇÃO" : "ok";
      console.log(`  ${t.dataConsulta} | [${tag}] ${t.nome} (${t.cpfFormatado})`);
      console.log(`    ${t.resumo}`);
      if (t.relatorioMd) console.log(`    relatório: ${t.relatorioMd}`);
    }
    return;
  }

  const cpf = opt(argv, "--cpf") ?? "";
  const nome = opt(argv, "--nome") ?? "";
  const nascimento = opt(argv, "--nascimento") ?? "";
  const baseLegal = opt(argv, "--base-legal") ?? "";
  const titular = opt(argv, "--titular") ?? nome;
  const solicitante = opt(argv, "--solicitante") ?? null;
  const semBrowser = argv.includes("--sem-browser");
  const timeoutMin = Number(opt(argv, "--timeout-min")) || 6;

  const erros: string[] = [];
  if (!cpf) erros.push("--cpf é obrigatório.");
  else if (!cpfValido(cpf)) erros.push(`CPF inválido: ${cpf}`);
  if (!nome.trim()) erros.push("--nome é obrigatório.");
  if (!nascimento) erros.push("--nascimento é obrigatório.");
  else if (!dataValida(nascimento))
    erros.push(`Data de nascimento inválida (use DD/MM/AAAA): ${nascimento}`);
  if (!baseLegal.trim()) {
    erros.push(
      "--base-legal é OBRIGATÓRIO (LGPD): registre a base legal da consulta " +
        '(ex.: "consentimento do locatário") antes de fazer a triagem.',
    );
  }

  if (erros.length) {
    console.error("Não foi possível iniciar a triagem:\n");
    for (const e of erros) console.error(`  • ${e}`);
    console.error("\n" + HELP);
    process.exit(1);
  }

  const locatario: DadosLocatario = {
    cpf: cpfDigits(cpf),
    cpfFormatado: cpfFormatado(cpf),
    nome: nome.trim(),
    nascimento: nascimento.trim(),
    maeNome: opt(argv, "--mae")?.trim() || null,
    paiNome: opt(argv, "--pai")?.trim() || null,
    ufNascimento: opt(argv, "--uf-nascimento")?.trim() || null,
    municipioNascimento: opt(argv, "--municipio-nascimento")?.trim() || null,
  };
  const lgpd: DadosLgpd = {
    baseLegal: baseLegal.trim(),
    titularConsentimento: titular.trim(),
    solicitante,
    finalidade:
      "Triagem de locatário (antecedentes criminais / processos) para análise de risco de locação.",
  };

  console.log(`Triagem para ${locatario.nome} (${locatario.cpfFormatado}).`);
  console.log(`  Base legal (LGPD): ${lgpd.baseLegal}`);
  console.log(`  Titular do consentimento: ${lgpd.titularConsentimento}`);

  let fontes: ResultadoFonte[];
  if (semBrowser) {
    console.log("\nModo --sem-browser: gerando só o relatório-esqueleto (fontes pendentes).");
    fontes = fontesPendentes();
  } else {
    const sel = fontesSelecionadas(argv);
    console.log(`  Fontes: ${sel.join(", ")} | timeout ${timeoutMin} min/fonte`);
    const precisaEnter = sel.includes("tjsc");
    fontes = await executarTriagem(locatario, {
      fontes: sel,
      timeoutMin,
      prompt: (m) => console.log(m),
      aguardarFim: precisaEnter ? () => aguardarFimTjsc(timeoutMin) : undefined,
      emailTjsc: opt(argv, "--email-resposta")?.trim() || null,
      finalidadeTjsc: opt(argv, "--finalidade")?.trim() || null,
    });
    // Preserva fontes do mesmo dia não reexecutadas (ex.: rodar só --pf depois
    // mantém o BNMP capturado antes).
    fontes = mesclarFontes(caminhoBase(locatario.cpf, opt(argv, "--out")), fontes);
  }

  const relatorio = montarRelatorio({ locatario, lgpd, fontes });
  const base = caminhoBase(locatario.cpf, opt(argv, "--out"));
  const { json, md } = gravarRelatorio(relatorio, base);

  // Grava no histórico (database/triagem.json) — exceto no esqueleto, que não
  // é uma consulta real. Idempotente por cpf+data (re-run no dia atualiza).
  let dbInfo = "";
  if (!semBrowser) {
    const { registro, acao } = registrarTriagem({
      locatario,
      relatorio,
      caminhoJson: json,
      caminhoMd: md,
    });
    dbInfo = `Histórico:  database/triagem.json (${acao}, id ${registro.id})`;
  }

  if (argv.includes("--json")) console.log(JSON.stringify(relatorio, null, 2));

  console.log("");
  console.log(relatorio.alertaGeral ? "RESULTADO: ATENÇÃO (há alerta)." : "RESULTADO: sem alertas automáticos.");
  console.log(`  ${relatorio.resumo}`);
  for (const f of relatorio.fontes) {
    const tag = f.status === "ok" ? (f.alerta ? "ALERTA" : "OK") : f.status.toUpperCase();
    console.log(`  • [${tag}] ${f.nome} — ${f.observacao}`);
  }
  console.log("");
  console.log(`Relatório: ${path.relative(REPO_ROOT, json)}`);
  console.log(`Resumo:    ${path.relative(REPO_ROOT, md)}`);
  if (dbInfo) console.log(dbInfo);
}
