/**
 * Backfill do campo `titulo` das infrações em database/cliente-despesas.json.
 *
 * Convenção (28/06/2026):
 * - `descricao` = texto cru do DETRAN.
 * - `titulo`    = "Multa {tipo} - {dataAutuacao}" (a tag ATRASADO é aplicada no push ao Rastreame).
 *
 * Para registros cuja `descricao` ainda guarda o título antigo (origem Rastreame, ex.:
 * "ATRASADO Multa velocidade - …"), o título é extraído dela; a `descricao` real do
 * DETRAN será preenchida na próxima execução de `sync-infracoes`.
 *
 * Uso:
 *   npx tsx scripts/backfillTituloInfracoes.ts --dry-run
 *   npx tsx scripts/backfillTituloInfracoes.ts
 */
import {
  editarClienteDespesa,
  loadClienteDespesasDb,
} from "../src/lib/clienteDespesasDb.js";
import {
  isCategoriaInfracao,
  normalizarTituloMulta,
  pareceTituloMulta,
  tituloInfracaoBase,
} from "../src/lib/infracaoTitulo.js";

function main(): void {
  const dry = process.argv.includes("--dry-run");
  const db = loadClienteDespesasDb();

  let total = 0;
  let alterados = 0;
  let semData = 0;

  for (const r of db.clienteDespesas) {
    if (!isCategoriaInfracao(r.categoria)) continue;
    total++;

    const desc = String(r.descricao ?? "");
    const titulo = pareceTituloMulta(desc)
      ? normalizarTituloMulta(desc)
      : tituloInfracaoBase(desc, r.dataAutuacao);

    if (!r.dataAutuacao?.trim()) semData++;

    if ((r.titulo ?? "") === titulo) continue;
    alterados++;
    console.log(
      `${r.autoInfracao.padEnd(12)} | ${r.veiculoId.padEnd(9)} | "${r.titulo ?? "(vazio)"}" -> "${titulo}"`,
    );
    if (!dry) editarClienteDespesa(r.id, { titulo });
  }

  console.log(
    `\nInfrações: ${total} | títulos ${dry ? "a atualizar" : "atualizados"}: ${alterados} | sem data: ${semData}`,
  );
  if (dry) console.log("(dry-run — nada gravado)");
}

main();
