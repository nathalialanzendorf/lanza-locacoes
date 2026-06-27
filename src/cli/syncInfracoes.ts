import fs from "node:fs";
import path from "node:path";

import {
  auditarInfracoesSemCondutor,
  printAuditoriaInfracoes,
} from "../lib/auditarInfracoes.js";
import {
  loadVeiculosParaSync,
  processarRespostaDetranSc,
  sincronizarMultasFrotaDetranSc,
  sincronizarMultasPorTicketDetranSc,
  sincronizarMultasVeiculoDetranSc,
  type SyncVeiculoResult,
} from "../lib/detranSc/syncVeiculo.js";
import { sincronizarFrotaDetranRs, type SyncDetranRsResult } from "../lib/detranRs/syncVeiculo.js";
import { RELATORIOS_SYNC_DIR, ensureRelatoriosDirs } from "../lib/relatoriosPaths.js";
import { ufRegistroDaPlaca } from "../lib/veiculoUf.js";

function printResumoRs(r: SyncDetranRsResult): void {
  console.log(
    `${r.placa} | IPVA/Lic novos:${r.novos} atu:${r.atualizados} sem alt:${r.semAlteracao} | infrações(resumo): ${r.infracoesResumo}`,
  );
  for (const a of r.avisos) console.log(`  aviso: ${a}`);
}

function printResumo(r: SyncVeiculoResult): void {
  console.log(
    `${r.placa} | novos: ${r.novos} | atualizados: ${r.atualizados} | sem alteração: ${r.semAlteracao} | histórico DETRAN: ${r.historico} | débitos parceiro ignorados: ${r.debitosIgnoradosProprietario}` +
      (r.revisarManual ? ` | ⚠ revisar manual: ${r.revisarManual}` : ""),
  );
  for (const a of r.avisos) console.log(`  aviso: ${a}`);
}

export async function main(argv: string[]): Promise<void> {
  let placa: string | undefined;
  let dryRun = false;
  let ticket: string | undefined;
  let captcha: string | undefined;
  let jsonIn: string | undefined;
  let prazoDias = 90;
  let delayMs = 1500;

  let noRs = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--no-rs" || a === "--sc-only") noRs = true;
    else if (a === "--placa" && argv[i + 1]) {
      placa = argv[++i];
    } else if (a === "--ticket" && argv[i + 1]) {
      ticket = argv[++i];
    } else if (a === "--captcha" && argv[i + 1]) {
      captcha = argv[++i];
    } else if (a === "--json" && argv[i + 1]) {
      jsonIn = argv[++i];
    } else if (a === "--prazo-dias" && argv[i + 1]) {
      prazoDias = Number(argv[++i]);
    } else if (a === "--delay-ms" && argv[i + 1]) {
      delayMs = Number(argv[++i]);
    } else if (a === "-h" || a === "--help") {
      console.log(`sync-infracoes [--placa PLACA] [--dry-run] [--prazo-dias N] [--delay-ms N]

A consulta DETRAN exige um token de captcha (Cloudflare Turnstile), gerado no
browser e de uso único — por isso a consulta automática em lote (frota) não é
possível. Use uma das opções por placa:
  --captcha "<c>" --placa PLACA   inicia a consulta (requisitar-consulta) com o
                                  token c capturado no DevTools e busca a resposta
  --ticket UUID --placa PLACA     usa direto o ticket t (resposta-consulta) já
                                  capturado no DevTools (mais simples)
  --json arquivo.json --placa PLACA   processa um JSON salvo (sem chamar API)

Variáveis de ambiente do utilizador: DETRAN_SC_AUTH, DETRAN_SC_EMPRESA [, DETRAN_SC_APP_VERSION]
TLS interceptado nesta rede: defina DETRAN_SC_TLS_INSECURE=1 (ou RASTREAME_TLS_INSECURE=1).
`);
      return;
    }
  }

  // Roteamento por UF: placa registrada no RS usa a tool DETRAN RS (chamada
  // unificada — traz IPVA/Licenciamento e o resumo de infrações de uma vez).
  if (placa && !noRs && ufRegistroDaPlaca(placa) === "RS") {
    console.log(`(${placa} é RS → tool DETRAN RS; infrações do RS vêm só como resumo)`);
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
    const raw = JSON.parse(fs.readFileSync(path.resolve(jsonIn), "utf8"));
    const r = processarRespostaDetranSc(placa, raw, { dryRun, prazoDias });
    printResumo(r);
    printAuditoriaInfracoes(auditarInfracoesSemCondutor(placa));
    return;
  }

  if (ticket) {
    if (!placa) {
      console.error("Com --ticket é obrigatório informar --placa");
      process.exit(1);
    }
    const veiculos = loadVeiculosParaSync(placa);
    const v = veiculos[0]!;
    const r = await sincronizarMultasPorTicketDetranSc(v.placa, ticket, {
      dryRun,
      prazoDias,
    });
    printResumo(r);
    printAuditoriaInfracoes(auditarInfracoesSemCondutor(v.placa));
    return;
  }

  if (placa) {
    const veiculos = loadVeiculosParaSync(placa);
    const v = veiculos[0]!;
    const r = await sincronizarMultasVeiculoDetranSc(v.placa, v.renavam, {
      dryRun,
      prazoDias,
      captcha,
    });
    printResumo(r);
    printAuditoriaInfracoes(auditarInfracoesSemCondutor(v.placa));
    return;
  }

  console.log(
    dryRun
      ? "[dry-run] Sincronizando frota (sem gravar cliente-despesas.json)..."
      : "Sincronizando infrações DETRAN SC...",
  );
  const results = await sincronizarMultasFrotaDetranSc({
    dryRun,
    prazoDias,
    delayMs,
  });

  let novos = 0;
  let atualizados = 0;
  for (const r of results) {
    printResumo(r);
    novos += r.novos;
    atualizados += r.atualizados;
  }
  console.log(
    `\nFrota SC: ${results.length} veículos | novos: ${novos} | atualizados: ${atualizados}`,
  );

  // DETRAN RS (ufRegistro="RS") — chamada unificada por veículo.
  const rsResults = noRs ? [] : await sincronizarFrotaDetranRs({ dryRun, delayMs });
  if (rsResults.length) {
    console.log(`\n— DETRAN RS —`);
    for (const r of rsResults) printResumoRs(r);
    console.log(`Frota RS: ${rsResults.length} veículo(s)`);
  }

  const auditoria = auditarInfracoesSemCondutor();
  printAuditoriaInfracoes(auditoria);

  ensureRelatoriosDirs();
  const outPath = path.join(RELATORIOS_SYNC_DIR, "_sync_infracoes.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      { sincronizadoEm: new Date().toISOString(), results, rsResults, auditoria },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`Relatório: ${outPath}`);
}
