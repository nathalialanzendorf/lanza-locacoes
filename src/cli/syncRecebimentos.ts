/**
 * Sincroniza Gastos Gerais (Rastreame) ↔ database/cliente-despesas.json.
 *
 * Uso:
 *   npx tsx src/run.ts sync-gastos-gerais [--dry-run] [--pull-only] [--push-only] [--force-pull] [--motorista KEY]
 *   (alias: sync-recebimentos)
 */
import { syncRecebimentos } from "../lib/rastreame/recebimentosSync.js";

export async function main(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(`Uso:
  sync-gastos-gerais [opções]   (alias: sync-recebimentos)

Opções:
  --dry-run        Simula sem gravar local nem chamar POST/PUT no Rastreame
  --pull-only      Só importa do Rastreame → cliente-despesas.json
  --push-only      Só exporta cliente-despesas.json → Rastreame
  --force-pull     Sobrescreve local mesmo se editado após última sync
  --motorista KEY  Filtra por motorista.key no Rastreame

Por defeito: push (local → Rastreame) e depois pull (Rastreame → local).
A base local é fonte da verdade; registos locais mais recentes prevalecem no pull.

Requer RASTREAME_AUTH ou RASTREAME_LOGIN+RASTREAME_SENHA nas variáveis de ambiente do utilizador.
`);
    process.exit(0);
  }

  const dryRun = argv.includes("--dry-run");
  const pullOnly = argv.includes("--pull-only");
  const pushOnly = argv.includes("--push-only");
  const forcePull = argv.includes("--force-pull");
  let motoristaKey: string | undefined;
  const mi = argv.indexOf("--motorista");
  if (mi >= 0) motoristaKey = argv[mi + 1];

  const r = await syncRecebimentos({
    dryRun,
    pull: !pushOnly,
    push: !pullOnly,
    forcePull,
    motoristaKey,
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
    `novos: ${r.pull.novos} | atualizados: ${r.pull.atualizados} | ignorados: ${r.pull.ignorados}`,
  );
  if (r.pull.erros.length) {
    console.log("Erros pull:");
    for (const e of r.pull.erros) console.log(`  - ${e}`);
  }

  if (r.push.erros.length || r.pull.erros.length) process.exit(1);
}
