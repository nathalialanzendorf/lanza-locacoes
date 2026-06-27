import fs from "node:fs";
import path from "node:path";

import { extrairContrato, fmtDataBr, parseDataBr, startOfDay } from "../lib/contratoExtrair.js";
import {
  loadContratosDb,
  registrarContrato,
  saveContratosDb,
  type MotivoEncerramento,
  type RegistrarContratoOpts,
} from "../lib/contratosDb.js";
import { defaultContratosDir } from "../lib/lanzaPaths.js";

const EXCL_PATH =
  /Modelo|compra e venda|contrato-compra|Or[çc]amentos|\sCopy\b|[\\/]Copy[\\/]|templates/i;
const NOME_PASTA_CONTRATO = /^\d{2}\.\d{2}\.\d{2,4}\s*-\s*.+/;

function temContratoDocx(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((f) => /^Contrato.*\.docx$/i.test(f));
  } catch {
    return false;
  }
}

const RE_ENCERRAMENTO = /devolv|entreg|recuper|recolh|troca|encerrad/i;
const RE_RECUPERADO = /recuper|recolh/i;
const RE_TROCA = /troca/i;

/** Parte do nome da pasta após "DD.MM.AAAA - " (nome + sufixo de status). */
function sufixoPasta(nomePasta: string): string {
  return nomePasta.replace(/^\d{2}\.\d{2}\.\d{2,4}\s*-\s*/, "");
}

function montarDataEncerramento(
  dd: number,
  mm: number,
  yy: number | null,
  inicio: Date,
): Date {
  let year: number;
  if (yy == null) {
    year = inicio.getFullYear();
    if (new Date(year, mm - 1, dd) < startOfDay(inicio)) year++;
  } else {
    year = yy < 100 ? 2000 + yy : yy;
  }
  return new Date(year, mm - 1, dd, 12, 0, 0);
}

type EncerramentoInferido = {
  dataEncerramento: string | null;
  motivoEncerramento: MotivoEncerramento;
  quebraContrato: boolean;
};

/** Infere encerramento (data/motivo/quebra) do sufixo da pasta, ex. "(devolvido 26.06)". */
function inferirEncerramento(
  nomePasta: string,
  inicio: Date,
  fim: Date,
): EncerramentoInferido | null {
  const suf = sufixoPasta(nomePasta);
  if (!RE_ENCERRAMENTO.test(suf)) return null;
  const ehTroca = RE_TROCA.test(suf);
  const motivoEncerramento: MotivoEncerramento = ehTroca
    ? "troca"
    : RE_RECUPERADO.test(suf)
      ? "recuperado"
      : "devolvido";
  const m = suf.match(/(\d{2})\.(\d{2})(?:\.(\d{2,4}))?/);
  let dataEncerramento: string | null = null;
  // Troca gera novo contrato com outro veículo: não é quebra (caução transfere).
  let quebraContrato = false;
  if (m) {
    const d = montarDataEncerramento(
      Number(m[1]),
      Number(m[2]),
      m[3] ? Number(m[3]) : null,
      inicio,
    );
    dataEncerramento = fmtDataBr(d);
    quebraContrato = ehTroca ? false : startOfDay(d) < startOfDay(fim);
  }
  return { dataEncerramento, motivoEncerramento, quebraContrato };
}

/** Acha todas as pastas DD.MM.AAAA - Nome com Contrato*.docx sob root. */
function acharPastasContrato(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      if (!ent.isDirectory()) continue;
      const p = path.join(dir, ent.name);
      if (EXCL_PATH.test(p)) continue;
      if (NOME_PASTA_CONTRATO.test(ent.name) && temContratoDocx(p)) {
        out.push(p);
        // não desce mais: a pasta de contrato é folha
        continue;
      }
      walk(p);
    }
  }
  walk(root);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

export async function main(argv: string[]): Promise<void> {
  let root: string | null = null;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--dry-run") dryRun = true;
    else if (a === "-h" || a === "--help") {
      console.log(`importar-contratos [RAIZ] [--dry-run]

Varre RAIZ (padrão: contratosDir de config/lanza_paths.json) procurando pastas
"DD.MM.AAAA - Nome" com Contrato*.docx e registra/atualiza database/contratos.json.
Idempotente por pastaContrato. --dry-run mostra sem gravar.`);
      return;
    } else if (!a.startsWith("-") && !root) root = path.resolve(a);
  }

  const raiz = root ?? defaultContratosDir();
  if (!fs.existsSync(raiz)) {
    console.error(`Raiz não encontrada: ${raiz}`);
    process.exit(1);
  }

  const pastas = acharPastasContrato(raiz);
  console.log(`Raiz: ${raiz}`);
  console.log(`Pastas de contrato encontradas: ${pastas.length}\n`);

  const existentes = new Set(
    loadContratosDb().contratos.map((c) => path.normalize(c.pastaContrato).toLowerCase()),
  );

  let novos = 0;
  let atualizados = 0;
  let encerrados = 0;
  const erros: { pasta: string; motivo: string }[] = [];

  for (const pasta of pastas) {
    const eraExistente = existentes.has(path.normalize(pasta).toLowerCase());
    try {
      const ext = extrairContrato(pasta);
      const enc = inferirEncerramento(path.basename(pasta), ext.inicio, ext.fim);
      const opts: RegistrarContratoOpts = enc
        ? {
            dataEncerramento: enc.dataEncerramento,
            motivoEncerramento: enc.motivoEncerramento,
            quebraContrato: enc.quebraContrato,
            status: "encerrado",
          }
        : {};
      const statusPrev = enc ? "encerrado" : "ativo";

      if (dryRun) {
        console.log(
          `[${eraExistente ? "atualizaria" : "novo"}] ${ext.clienteNome} | ${ext.placa} | ${ext.tipoContrato} | ${statusPrev}${enc?.dataEncerramento ? ` ${enc.dataEncerramento}` : ""}${enc ? ` (${enc.motivoEncerramento}${enc.quebraContrato ? ", quebra" : ""})` : ""}`,
        );
      } else {
        const r = registrarContrato(pasta, opts);
        console.log(
          `[${eraExistente ? "atualizado" : "novo"}] ${r.clienteNome} | ${r.placa} | v${r.versao} | ${r.status}${r.dataEncerramento ? ` ${r.dataEncerramento}` : ""} | ${r.tipoContrato}`,
        );
      }
      if (enc) encerrados++;
      if (eraExistente) atualizados++;
      else novos++;
    } catch (e) {
      const motivo = e instanceof Error ? e.message : String(e);
      erros.push({ pasta, motivo });
      console.log(`[ERRO] ${path.basename(pasta)} :: ${motivo}`);
    }
  }

  // Reconciliação: aplica encerramento pelo NOME já gravado em contratos.json
  // (cobre pastas que não foram re-varridas, ex.: arquivadas/online-only no Dropbox).
  let reconc = 0;
  if (!dryRun) {
    const db = loadContratosDb();
    for (const c of db.contratos) {
      const inicio = parseDataBr(c.dataInicio);
      const fim = parseDataBr(c.dataFimPrevista);
      if (!inicio || !fim) continue;
      const enc = inferirEncerramento(path.basename(c.pastaContrato), inicio, fim);
      if (!enc) continue;
      const mudou =
        c.status !== "encerrado" ||
        c.motivoEncerramento !== enc.motivoEncerramento ||
        (c.dataEncerramento ?? null) !== (c.dataEncerramento ?? enc.dataEncerramento);
      c.status = "encerrado";
      c.motivoEncerramento = enc.motivoEncerramento;
      c.quebraContrato = enc.quebraContrato;
      if (!c.dataEncerramento && enc.dataEncerramento) c.dataEncerramento = enc.dataEncerramento;
      if (mudou) reconc++;
    }
    saveContratosDb(db);
  }

  console.log(
    `\n${dryRun ? "[dry-run] " : ""}Total: ${pastas.length} | novos: ${novos} | atualizados: ${atualizados} | encerrados: ${encerrados} | reconciliados: ${reconc} | erros: ${erros.length}`,
  );
  if (erros.length) {
    console.log(`\nPastas com erro (revisar manualmente):`);
    for (const e of erros) console.log(`  • ${e.pasta}\n      ${e.motivo}`);
  }
}
