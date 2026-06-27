import fs from "node:fs";
import path from "node:path";

import {
  loadPlacasParaSync,
  processarPassagensJson,
  processarPassagensJsonLote,
  sincronizarPedagiosFrota,
  sincronizarPedagiosVeiculo,
  type SyncPedagiosResult,
} from "../lib/pedagioDigital/syncPedagios.js";
import { RELATORIOS_SYNC_DIR, ensureRelatoriosDirs } from "../lib/relatoriosPaths.js";

function printResumo(r: SyncPedagiosResult): void {
  console.log(
    `${r.placa} | novos: ${r.novos} | atualizados: ${r.atualizados} | sem alteração: ${r.semAlteracao} | ignorados: ${r.ignorados}`,
  );
  for (const a of r.avisos) console.log(`  aviso: ${a}`);
}

export async function main(argv: string[]): Promise<void> {
  let placa: string | undefined;
  let dryRun = false;
  let jsonIn: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--placa" && argv[i + 1]) placa = argv[++i];
    else if (a === "--json" && argv[i + 1]) jsonIn = argv[++i];
    else if (a === "-h" || a === "--help") {
      console.log(`sync-pedagios [--placa PLACA] [--dry-run] [--json arquivo.json]

Grava as passagens EM ABERTO do pedagiodigital.com em database/cliente-despesas.json
(categoria "Pedágio"); o push para o Rastreame é feito por sync-recebimentos.

API: GET /bff/api/Passagem/list-logado?placas=P1,P2,... (uma chamada para toda a frota).
A sessão do BFF é curta; se expirar, prefira o modo offline abaixo.

Modo offline (resposta já capturada no DevTools → Response → Save):
  --json arquivo.json             processa TODAS as placas ativas (resposta de list-logado)
  --json arquivo.json --placa P   processa só a placa P

Variáveis de ambiente do utilizador: PEDAGIO_DIGITAL_COOKIE + PEDAGIO_DIGITAL_CSRF
(sessão capturada no DevTools) ou PEDAGIO_DIGITAL_LOGIN + PEDAGIO_DIGITAL_SENHA.

Sem --placa: percorre todas as placas ativas em database/veiculos.json.
`);
      return;
    }
  }

  if (jsonIn && placa) {
    loadPlacasParaSync(placa);
    printResumo(processarPassagensJson(placa, jsonIn, { dryRun }));
    return;
  }

  if (placa) {
    loadPlacasParaSync(placa);
    printResumo(await sincronizarPedagiosVeiculo(placa, { dryRun }));
    return;
  }

  console.log(
    dryRun
      ? "[dry-run] Processando pedágios da frota (sem gravar cliente-despesas.json)..."
      : "Sincronizando pedágios em aberto (pedagiodigital.com)...",
  );
  const results = jsonIn
    ? processarPassagensJsonLote(jsonIn, { dryRun })
    : await sincronizarPedagiosFrota({ dryRun });

  let novos = 0;
  let atualizados = 0;
  for (const r of results) {
    printResumo(r);
    novos += r.novos;
    atualizados += r.atualizados;
  }
  console.log(
    `\nFrota: ${results.length} veículos | novos: ${novos} | atualizados: ${atualizados}`,
  );

  ensureRelatoriosDirs();
  const outPath = path.join(RELATORIOS_SYNC_DIR, "_sync_pedagios.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify({ sincronizadoEm: new Date().toISOString(), results }, null, 2),
    "utf8",
  );
  console.log(`Relatório: ${outPath}`);
}
