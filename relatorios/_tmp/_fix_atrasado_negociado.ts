/**
 * One-off: remove a tag ATRASADO dos gastos já marcados [NEGOCIADO 2] (Juliano/Focus).
 *   npx tsx relatorios/_tmp/_fix_atrasado_negociado.ts            (dry-run)
 *   npx tsx relatorios/_tmp/_fix_atrasado_negociado.ts --execute
 */
import { fetchGastoById, putGasto } from "../../src/lib/rastreame/gasto.js";
import { removerTagAtrasado } from "../../src/lib/rastreame/renegociacao.js";

const IDS = [595, 596, 526, 532, 597, 598, 531];
const execute = process.argv.includes("--execute");

function novaInfo(info: string): string {
  const t = String(info ?? "").trim();
  const m = t.match(/^(\[NEGOCIADO[^\]]*\])\s*(.*)$/);
  if (!m) return removerTagAtrasado(t);
  return `${m[1]} ${removerTagAtrasado(m[2]!)}`.trim();
}

async function main(): Promise<void> {
  for (const id of IDS) {
    const g = await fetchGastoById(id);
    const antes = String(g.info ?? "");
    const depois = novaInfo(antes);
    if (antes === depois) {
      console.log(`  id ${id}: sem mudança`);
      continue;
    }
    console.log(`  id ${id}: "${antes}" → "${depois}"`);
    if (execute) {
      const body = { ...g, info: depois };
      const r = await putGasto(id, body);
      if (!r.ok) {
        const txt = await r.text();
        throw new Error(`PUT ${id} falhou: ${r.status} ${txt.slice(0, 200)}`);
      }
    }
  }
  console.log(execute ? "OK (executado)" : "dry-run (use --execute)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
