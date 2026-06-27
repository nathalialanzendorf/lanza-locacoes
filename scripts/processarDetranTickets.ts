/**
 * Processa tickets DETRAN capturados no navegador (detran_tickets.json):
 *   - busca a resposta de cada ticket no servidor (resposta-consulta, sem captcha);
 *   - identifica a placa pelo próprio payload e mapeia para a frota local;
 *   - grava INFRAÇÕES (cliente-despesas) e IPVA/LICENCIAMENTO (parceiro-despesas).
 *
 * Uso: npx tsx scripts/processarDetranTickets.ts [caminho/detran_tickets.json] [--dry-run]
 * (default: %USERPROFILE%\Downloads\detran_tickets.json)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { consultarVeiculoDetranScPorTicket } from "../src/lib/detranSc/consulta.js";
import { processarDespesasDetranSc } from "../src/lib/detranSc/syncDespesasVeiculo.js";
import { processarRespostaDetranSc } from "../src/lib/detranSc/syncVeiculo.js";
import { compactPlaca } from "../src/lib/placa.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const fileArg = args.find((a) => !a.startsWith("--"));
const FILE = fileArg
  ? path.resolve(fileArg)
  : path.join(os.homedir(), "Downloads", "detran_tickets.json");
const OUT_DIR = path.resolve("relatorios/_tmp/detran");

type TicketEntry = { placa?: string; ticket: string };

function lerTickets(): TicketEntry[] {
  const raw = JSON.parse(fs.readFileSync(FILE, "utf8").replace(/^\uFEFF/, ""));
  const arr: unknown = Array.isArray(raw) ? raw : raw?.tickets;
  if (!Array.isArray(arr)) throw new Error("arquivo sem array de tickets");
  const out: TicketEntry[] = [];
  for (const t of arr) {
    if (typeof t === "string") out.push({ ticket: t });
    else if (t && typeof t === "object" && typeof (t as any).ticket === "string")
      out.push({ placa: (t as any).placa, ticket: (t as any).ticket });
  }
  return out;
}

function placaDoPayload(raw: unknown): string | undefined {
  const found: string[] = [];
  const dig = (o: any) => {
    if (o && typeof o === "object") {
      if (typeof o.placa === "string" && o.placa.trim()) found.push(o.placa.trim());
      for (const k of ["data", "veiculo", "resultado", "payload", "content"]) dig(o[k]);
    }
  };
  dig(raw);
  return found[0];
}

function carregarMapaFrota(): Map<string, string> {
  const raw = JSON.parse(fs.readFileSync(path.resolve("database/veiculos.json"), "utf8"));
  const arr: any[] = Array.isArray(raw) ? raw : raw.veiculos ?? Object.values(raw);
  const map = new Map<string, string>();
  for (const v of arr) {
    if (v && typeof v.placa === "string") {
      map.set(compactPlaca(v.placa), v.placa);
      // Alias explícito da placa antiga (ex.: DETRAN devolve a placa pré-Mercosul).
      if (typeof v.placaAntiga === "string" && v.placaAntiga.trim()) {
        map.set(compactPlaca(v.placaAntiga), v.placa);
      }
    }
  }
  return map;
}

function processarDespesasSalvas(): void {
  const frota = carregarMapaFrota();
  if (!fs.existsSync(OUT_DIR)) {
    console.log("Sem payloads salvos em", OUT_DIR);
    return;
  }
  const arquivos = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith(".json"));
  console.log(`Reprocessando IPVA/Licenciamento de ${arquivos.length} payload(s) salvos${dryRun ? " | DRY-RUN" : ""}\n`);
  for (const arq of arquivos) {
    const compact = path.basename(arq, ".json").toUpperCase();
    const placaFrota = frota.get(compact);
    if (!placaFrota) {
      console.log(`⚠ ${compact} não está na frota — ignorado`);
      continue;
    }
    const payload = JSON.parse(fs.readFileSync(path.join(OUT_DIR, arq), "utf8"));
    const r = processarDespesasDetranSc(placaFrota, payload, { dryRun });
    console.log(`✓ ${placaFrota} | IPVA/LIC novos:${r.novos} atu:${r.atualizados} semAlt:${r.semAlteracao} ign:${r.ignorados}`);
    for (const a of r.avisos) console.log(`    desp: ${a}`);
  }
}

function extrairPayloads(raw: unknown): unknown[] {
  const arr = Array.isArray(raw) ? raw : (raw as any)?.dados ?? [];
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => (x && typeof x === "object" && "payload" in x ? (x as any).payload : x));
}

function processarDataFile(file: string): void {
  const raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  const payloads = extrairPayloads(raw);
  const frota = carregarMapaFrota();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Arquivo (payloads): ${file} | itens: ${payloads.length}${dryRun ? " | DRY-RUN" : ""}\n`);

  let ok = 0;
  for (const payload of payloads) {
    const placaCompact = compactPlaca(placaDoPayload(payload) ?? "");
    const placaFrota = frota.get(placaCompact);
    if (!placaFrota) {
      console.log(`⚠ placa "${placaCompact || "?"}" não está na frota — ignorado`);
      continue;
    }
    fs.writeFileSync(path.join(OUT_DIR, `${compactPlaca(placaFrota)}.json`), JSON.stringify(payload, null, 2), "utf8");
    const inf = processarRespostaDetranSc(placaFrota, payload, { dryRun, prazoDias: 90 });
    const desp = processarDespesasDetranSc(placaFrota, payload, { dryRun });
    ok++;
    console.log(
      `✓ ${placaFrota} | INFRAÇÕES novos:${inf.novos} atu:${inf.atualizados} hist:${inf.historico}` +
        (inf.revisarManual ? ` revisar:${inf.revisarManual}` : "") +
        ` | IPVA/LIC novos:${desp.novos} atu:${desp.atualizados} ign:${desp.ignorados}`,
    );
  }
  console.log(`\nProcessados ${ok} veículo(s).`);
}

async function main(): Promise<void> {
  if (args.includes("--saved-despesas")) {
    processarDespesasSalvas();
    return;
  }

  const dataIdx = args.indexOf("--data");
  if (dataIdx >= 0 && args[dataIdx + 1]) {
    processarDataFile(path.resolve(args[dataIdx + 1]!));
    return;
  }

  const tickets = lerTickets();
  const frota = carregarMapaFrota();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const vistos = new Set<string>();
  let okCount = 0;
  console.log(`Arquivo: ${FILE} | tickets: ${tickets.length}${dryRun ? " | DRY-RUN" : ""}\n`);

  for (const t of tickets) {
    if (vistos.has(t.ticket)) continue;
    vistos.add(t.ticket);

    let payload: unknown;
    try {
      payload = await consultarVeiculoDetranScPorTicket(t.ticket);
    } catch (e) {
      console.log(`✗ ticket ${t.ticket.slice(0, 8)}… erro: ${(e as Error).message}`);
      continue;
    }

    const placaCompact = compactPlaca(placaDoPayload(payload) ?? "");
    const placaFrota = frota.get(placaCompact);
    if (!placaFrota) {
      console.log(`⚠ ticket ${t.ticket.slice(0, 8)}… placa "${placaCompact || "?"}" não está na frota — ignorado`);
      continue;
    }

    const arq = path.join(OUT_DIR, `${compactPlaca(placaFrota)}.json`);
    fs.writeFileSync(arq, JSON.stringify(payload, null, 2), "utf8");

    const inf = processarRespostaDetranSc(placaFrota, payload, { dryRun, prazoDias: 90 });
    const desp = processarDespesasDetranSc(placaFrota, payload, { dryRun });
    okCount++;
    console.log(
      `✓ ${placaFrota} | INFRAÇÕES novos:${inf.novos} atu:${inf.atualizados} hist:${inf.historico}` +
        (inf.revisarManual ? ` revisar:${inf.revisarManual}` : "") +
        ` | IPVA/LIC novos:${desp.novos} atu:${desp.atualizados} ign:${desp.ignorados}`,
    );
    for (const a of inf.avisos) console.log(`    inf: ${a}`);
    for (const a of desp.avisos) console.log(`    desp: ${a}`);
  }

  console.log(`\nProcessados ${okCount} veículo(s). Payloads salvos em ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
