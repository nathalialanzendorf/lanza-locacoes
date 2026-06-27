/**
 * Sincroniza rastreáveis (Rastreame) ↔ database/veiculos.json.
 *
 * Uso:
 *   npx tsx src/run.ts sync-rastreaveis [--dry-run] [--pull-only] [--push-only] [--force-pull]
 */
import { syncRastreaveis } from "../lib/rastreame/rastreaveisSync.js";

export async function main(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(`Uso:
  sync-rastreaveis [opções]

Opções:
  --dry-run      Simula sem gravar local nem chamar POST/PUT no Rastreame
  --pull-only    Só importa do Rastreame → veiculos.json
  --push-only    Só exporta veiculos.json → Rastreame
  --force-pull   Sobrescreve local mesmo se editado após última sync
  --no-fipe      Não resolver FIPE dos veículos novos/sem FIPE após o pull

Por defeito: push (local → Rastreame), pull (Rastreame → local) e FIPE (resolve
veículos sem FIPE via tool fipe). veiculos.json é fonte da verdade; veículo
ausente no Rastreame é inativado localmente.

Requer RASTREAME_AUTH ou RASTREAME_LOGIN+RASTREAME_SENHA nas variáveis de ambiente do utilizador.
`);
    process.exit(0);
  }

  const dryRun = argv.includes("--dry-run");
  const pullOnly = argv.includes("--pull-only");
  const pushOnly = argv.includes("--push-only");
  const forcePull = argv.includes("--force-pull");
  const noFipe = argv.includes("--no-fipe");

  const r = await syncRastreaveis({
    dryRun,
    pull: !pushOnly,
    push: !pullOnly,
    forcePull,
    fipe: !noFipe,
  });

  console.log("\n=== Push (local → Rastreame) ===");
  console.log(
    `criados: ${r.push.criados} | atualizados: ${r.push.atualizados} | inativados: ${r.push.inativados} | ignorados: ${r.push.ignorados}`,
  );
  if (r.push.erros.length) {
    console.log("Erros push:");
    for (const e of r.push.erros) console.log(`  - ${e}`);
  }

  console.log("\n=== Pull (Rastreame → local) ===");
  console.log(
    `novos: ${r.pull.novos} | atualizados: ${r.pull.atualizados} | inativados: ${r.pull.inativados} | ignorados: ${r.pull.ignorados}`,
  );
  if (r.pull.erros.length) {
    console.log("Erros pull:");
    for (const e of r.pull.erros) console.log(`  - ${e}`);
  }

  console.log("\n=== FIPE (veículos novos/sem FIPE) ===");
  console.log(`atualizados: ${r.fipe.atualizados} | ignorados: ${r.fipe.ignorados}`);
  if (r.fipe.erros.length) {
    console.log("Erros FIPE:");
    for (const e of r.fipe.erros) console.log(`  - ${e}`);
  }

  if (r.push.erros.length || r.pull.erros.length) process.exit(1);
}
