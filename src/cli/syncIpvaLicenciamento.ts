import fs from "node:fs";
import path from "node:path";

import {
  processarDespesasDetranSc,
  sincronizarDespesasFrotaDetranSc,
  sincronizarDespesasPorTicketDetranSc,
  sincronizarDespesasVeiculoDetranSc,
  type SyncDespesasResult,
} from "../lib/detranSc/syncDespesasVeiculo.js";
import { loadVeiculosParaSync } from "../lib/detranSc/syncVeiculo.js";
import { sincronizarFrotaDetranRs, type SyncDetranRsResult } from "../lib/detranRs/syncVeiculo.js";
import { RELATORIOS_SYNC_DIR, ensureRelatoriosDirs } from "../lib/relatoriosPaths.js";
import { ufRegistroDaPlaca } from "../lib/veiculoUf.js";

function printResumoRs(r: SyncDetranRsResult): void {
  console.log(
    `${r.placa} | novos: ${r.novos} | atualizados: ${r.atualizados} | sem alteração: ${r.semAlteracao} | ignorados: ${r.ignorados} | infrações(resumo): ${r.infracoesResumo}`,
  );
  for (const a of r.avisos) console.log(`  aviso: ${a}`);
}

function printResumo(r: SyncDespesasResult): void {
  console.log(
    `${r.placa} | novos: ${r.novos} | atualizados: ${r.atualizados} | sem alteração: ${r.semAlteracao} | débitos ignorados (não IPVA/lic.): ${r.ignorados}`,
  );
  for (const a of r.avisos) console.log(`  aviso: ${a}`);
}

export async function main(argv: string[]): Promise<void> {
  let placa: string | undefined;
  let dryRun = false;
  let ticket: string | undefined;
  let captcha: string | undefined;
  let jsonIn: string | undefined;
  let delayMs = 1500;

  let noRs = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--no-rs" || a === "--sc-only") noRs = true;
    else if (a === "--placa" && argv[i + 1]) placa = argv[++i];
    else if (a === "--ticket" && argv[i + 1]) ticket = argv[++i];
    else if (a === "--captcha" && argv[i + 1]) captcha = argv[++i];
    else if (a === "--json" && argv[i + 1]) jsonIn = argv[++i];
    else if (a === "--delay-ms" && argv[i + 1]) delayMs = Number(argv[++i]);
    else if (a === "-h" || a === "--help") {
      console.log(`sync-ipva-licenciamento [--placa PLACA] [--dry-run] [--delay-ms N]

Sincroniza débitos de IPVA e Licenciamento (DETRAN SC) → database/parceiro-despesas.json.

A consulta DETRAN exige captcha (Cloudflare Turnstile) por placa → sem frota
automática. Use por placa:
  --captcha "<c>" --placa PLACA   requisitar-consulta com o token c do DevTools
  --ticket UUID --placa PLACA     resposta-consulta com o ticket t do DevTools
  --json arquivo.json --placa PLACA   processa um JSON salvo (sem chamar API)

Variáveis de ambiente do utilizador: DETRAN_SC_AUTH, DETRAN_SC_EMPRESA [, DETRAN_SC_APP_VERSION]
TLS interceptado nesta rede: defina DETRAN_SC_TLS_INSECURE=1 (ou RASTREAME_TLS_INSECURE=1).
`);
      return;
    }
  }

  // Roteamento por UF: placa registrada no RS usa a tool DETRAN RS.
  if (placa && !noRs && ufRegistroDaPlaca(placa) === "RS") {
    console.log(`(${placa} é RS → tool DETRAN RS)`);
    const rsArgs = ["--placa", placa];
    if (jsonIn) rsArgs.push("--json", jsonIn);
    if (dryRun) rsArgs.push("--dry-run");
    await (await import("./syncDetranRs.js")).main(rsArgs);
    return;
  }

  if (jsonIn) {
    if (!placa) {
      console.error("Com --json é obrigatório informar --placa");
      process.exit(1);
    }
    printResumo(processarDespesasDetranSc(placa, JSON.parse(fs.readFileSync(path.resolve(jsonIn), "utf8")), { dryRun }));
    return;
  }

  if (ticket) {
    if (!placa) {
      console.error("Com --ticket é obrigatório informar --placa");
      process.exit(1);
    }
    const v = loadVeiculosParaSync(placa)[0]!;
    printResumo(await sincronizarDespesasPorTicketDetranSc(v.placa, ticket, { dryRun }));
    return;
  }

  if (placa) {
    const v = loadVeiculosParaSync(placa)[0]!;
    printResumo(await sincronizarDespesasVeiculoDetranSc(v.placa, v.renavam, { dryRun, captcha }));
    return;
  }

  console.log(
    dryRun
      ? "[dry-run] Sincronizando IPVA/Licenciamento (sem gravar parceiro-despesas.json)..."
      : "Sincronizando IPVA/Licenciamento DETRAN SC...",
  );
  const results = await sincronizarDespesasFrotaDetranSc({ dryRun, delayMs });
  let novos = 0;
  let atualizados = 0;
  for (const r of results) {
    printResumo(r);
    novos += r.novos;
    atualizados += r.atualizados;
  }
  console.log(`\nFrota SC: ${results.length} veículos | novos: ${novos} | atualizados: ${atualizados}`);

  // DETRAN RS (ufRegistro="RS") — chamada unificada por veículo.
  const rsResults = noRs ? [] : await sincronizarFrotaDetranRs({ dryRun, delayMs });
  if (rsResults.length) {
    console.log(`\n— DETRAN RS —`);
    for (const r of rsResults) printResumoRs(r);
    console.log(`Frota RS: ${rsResults.length} veículo(s)`);
  }

  ensureRelatoriosDirs();
  const outPath = path.join(RELATORIOS_SYNC_DIR, "_sync_ipva_licenciamento.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify({ sincronizadoEm: new Date().toISOString(), results, rsResults }, null, 2),
    "utf8",
  );
  console.log(`Relatório: ${outPath}`);
}
