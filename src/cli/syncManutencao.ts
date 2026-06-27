/**
 * Espelha despesas de parceiro (parceiro-despesas.json) na tela Manutenção do Rastreame.
 *
 * Uso:
 *   npx tsx src/run.ts sync-manutencao [--placa PLACA] [--categoria CAT] [--dry-run]
 *
 * Despesa de parceiro → tela Manutenção (tipo OUTROS).
 * Despesa de cliente → Gastos Gerais via `sync-recebimentos` (não aqui).
 *
 * Requer RASTREAME_AUTH (ou RASTREAME_LOGIN+RASTREAME_SENHA).
 */
import { pushManutencoesToRastreame } from "../lib/rastreame/manutencaoSync.js";

export async function main(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(`Uso:
  sync-manutencao [--placa PLACA] [--categoria CAT] [--dry-run]

Espelha despesas de parceiro (parceiro-despesas.json) na tela Manutenção do Rastreame.
  --placa PLACA      Filtra por placa
  --categoria CAT    Filtra por categoria (Seguro, Rastreador, IPVA, Licenciamento, ...)
  --dry-run          Simula sem POST/PUT no Rastreame

Idempotente: com rastreameManutencaoId faz PUT (ou skip se nada mudou); sem id
deduplica por (rastreável + info + data) e só então faz POST.
`);
    process.exit(0);
  }

  let placa: string | undefined;
  let categoria: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--placa" && argv[i + 1]) placa = argv[++i]!;
    else if (a === "--categoria" && argv[i + 1]) categoria = argv[++i]!;
    else if (a === "--dry-run") dryRun = true;
  }

  const r = await pushManutencoesToRastreame({ placa, categoria, dryRun });
  const prefix = dryRun ? "[dry-run] " : "";
  console.log(
    `${prefix}Manutenção (parceiro → Rastreame): ${r.criados} criados | ${r.atualizados} atualizados | ${r.semAlteracao} sem alteração | ${r.ignorados} ignorados | ${r.baixados} baixados (Pago no Rastreame)`,
  );
  if (r.erros.length) {
    console.log("Avisos/erros:");
    for (const e of r.erros) console.log(`  - ${e}`);
  }
  const fatais = r.erros.filter((e) => !/rastreável não resolvido/.test(e));
  if (fatais.length) process.exit(1);
}
