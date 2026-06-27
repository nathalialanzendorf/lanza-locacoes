import fs from "node:fs";
import path from "node:path";

import { RELATORIOS_SYNC_DIR, ensureRelatoriosDirs } from "../lib/relatoriosPaths.js";
import {
  loadVeiculosRsParaSync,
  processarRespostaDetranRs,
  sincronizarFrotaDetranRs,
  sincronizarVeiculoDetranRs,
  type SyncDetranRsResult,
} from "../lib/detranRs/syncVeiculo.js";

function printResumo(r: SyncDetranRsResult): void {
  console.log(
    `${r.placa} | novos: ${r.novos} | atualizados: ${r.atualizados} | sem alteração: ${r.semAlteracao} | ignorados: ${r.ignorados} | infrações(resumo): ${r.infracoesResumo}`,
  );
  for (const a of r.avisos) console.log(`  aviso: ${a}`);
}

export async function main(argv: string[]): Promise<void> {
  let placa: string | undefined;
  let dryRun = false;
  let jsonIn: string | undefined;
  let delayMs = 1500;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--placa" && argv[i + 1]) placa = argv[++i];
    else if (a === "--json" && argv[i + 1]) jsonIn = argv[++i];
    else if (a === "--delay-ms" && argv[i + 1]) delayMs = Number(argv[++i]);
    else if (a === "-h" || a === "--help") {
      console.log(`sync-detran-rs [--placa PLACA] [--dry-run] [--delay-ms N] [--json arquivo.json]

Sincroniza IPVA e Licenciamento do DETRAN RS (PROCERGS) → database/parceiro-despesas.json.
Processa apenas veículos ATIVOS com ufRegistro="RS". O endpoint do RS devolve só o
RESUMO das infrações (sem detalhe por multa) — essas ficam como aviso para revisão manual.

  (sem args)                      sincroniza toda a frota RS
  --placa PLACA                   só esse veículo (precisa ter ufRegistro="RS")
  --json arquivo.json --placa P   processa um JSON salvo (sem chamar a API)
  --dry-run                       não grava parceiro-despesas.json

Variáveis de ambiente do utilizador: DETRAN_RS_AUTH (Bearer), DETRAN_RS_USER_ID (X-User-Id).
TLS interceptado nesta rede: defina DETRAN_RS_TLS_INSECURE=1.
`);
      return;
    }
  }

  if (jsonIn) {
    if (!placa) {
      console.error("Com --json é obrigatório informar --placa");
      process.exit(1);
    }
    const raw = JSON.parse(fs.readFileSync(path.resolve(jsonIn), "utf8"));
    printResumo(processarRespostaDetranRs(placa, raw, { dryRun }));
    return;
  }

  if (placa) {
    const v = loadVeiculosRsParaSync(placa)[0]!;
    printResumo(await sincronizarVeiculoDetranRs(v.placa, v.renavam, { dryRun }));
    return;
  }

  console.log(
    dryRun
      ? "[dry-run] Sincronizando DETRAN RS (sem gravar parceiro-despesas.json)..."
      : "Sincronizando IPVA/Licenciamento DETRAN RS...",
  );
  const results = await sincronizarFrotaDetranRs({ dryRun, delayMs });
  let novos = 0;
  let atualizados = 0;
  for (const r of results) {
    printResumo(r);
    novos += r.novos;
    atualizados += r.atualizados;
  }
  console.log(`\nFrota RS: ${results.length} veículo(s) | novos: ${novos} | atualizados: ${atualizados}`);

  ensureRelatoriosDirs();
  const outPath = path.join(RELATORIOS_SYNC_DIR, "_sync_detran_rs.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify({ sincronizadoEm: new Date().toISOString(), results }, null, 2),
    "utf8",
  );
  console.log(`Relatório: ${outPath}`);
}
