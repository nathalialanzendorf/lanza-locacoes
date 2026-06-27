/**
 * Reconcilia duplicidade de infrações em database/cliente-despesas.json.
 *
 * Cada multa pode aparecer 2x: o registro do DETRAN (auto real, ex. CRC0883952) e o
 * espelho do Rastreame (RAST-<id>), criado no pull antes do sync do DETRAN. Como a chave
 * é o `autoInfracao`, eles não se deduplicam.
 *
 * Este script casa o par por **placa + valor + data (dia, e hora quando disponível)** e:
 *  - move o vínculo do Rastreame (rastreameId e chaves) do RAST-* para o registro do DETRAN;
 *  - força re-push (limpa rastreameSyncEm) para o título do gasto ser renomeado no próximo sync;
 *  - inativa o espelho RAST-* localmente (ativo:false) APÓS remover o rastreameId,
 *    para o push NÃO inativar o gasto no Rastreame (o DETRAN passou a ser o dono do vínculo).
 *
 * Uso:
 *   npx tsx scripts/dedupInfracoesRast.ts            # dry-run (não grava)
 *   npx tsx scripts/dedupInfracoesRast.ts --apply    # aplica
 */
import {
  loadClienteDespesasDb,
  saveClienteDespesasDb,
  type ClienteDespesaRegistro,
} from "../src/lib/clienteDespesasDb.js";
import { isCategoriaInfracao } from "../src/lib/infracaoTitulo.js";
import { placasIguais } from "../src/lib/placa.js";

function diaDe(s: string | null | undefined): string {
  const m = String(s ?? "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
}

function horaDe(reg: ClienteDespesaRegistro): string {
  const m1 = String(reg.dataAutuacao ?? "").match(/\b(\d{2}):(\d{2})\b/);
  if (m1) return `${m1[1]}:${m1[2]}`;
  const m2 = String(reg.descricao ?? "").match(/\b(\d{2}):(\d{2})\b/);
  if (m2) return `${m2[1]}:${m2[2]}`;
  if (reg.rastreameDataIso) {
    const d = new Date(reg.rastreameDataIso);
    if (!Number.isNaN(d.getTime())) {
      // Converte para horário de Brasília (UTC-3).
      const br = new Date(d.getTime() - 3 * 60 * 60 * 1000);
      return `${String(br.getUTCHours()).padStart(2, "0")}:${String(br.getUTCMinutes()).padStart(2, "0")}`;
    }
  }
  return "";
}

function isRast(reg: ClienteDespesaRegistro): boolean {
  return /^RAST-/i.test(reg.autoInfracao);
}

function main(): void {
  const apply = process.argv.includes("--apply");
  const db = loadClienteDespesasDb();
  const infra = db.clienteDespesas.filter(
    (r) => isCategoriaInfracao(r.categoria) && r.ativo !== false,
  );
  const rastList = infra.filter(isRast);
  const detranList = infra.filter((r) => !isRast(r));

  const usados = new Set<string>();
  const matches: Array<{ rast: ClienteDespesaRegistro; detran: ClienteDespesaRegistro }> = [];
  const semPar: ClienteDespesaRegistro[] = [];
  const ambiguos: ClienteDespesaRegistro[] = [];

  for (const rast of rastList) {
    // Não mexer em débitos renegociados (têm tag [NEGOCIADO]/RENEGOCIADO no título).
    if (/negociad/i.test(rast.descricao)) {
      semPar.push(rast);
      continue;
    }
    // No espelho RAST a data real da multa está no título (descricao); o campo
    // dataAutuacao costuma trazer só a data do gasto. Por isso priorizamos o título.
    const diaR = diaDe(rast.descricao) || diaDe(rast.dataAutuacao);
    const horaR = horaDe(rast);
    let cands = detranList.filter(
      (d) =>
        !usados.has(d.id) &&
        placasIguais(d.veiculoId, rast.veiculoId) &&
        Math.abs((d.valorMulta || 0) - (rast.valorMulta || 0)) < 0.01 &&
        diaDe(d.dataAutuacao) === diaR &&
        diaR !== "",
    );

    if (cands.length > 1 && horaR) {
      const porHora = cands.filter((d) => horaDe(d) === horaR);
      if (porHora.length >= 1) cands = porHora;
    }

    if (cands.length === 1) {
      matches.push({ rast, detran: cands[0]! });
      usados.add(cands[0]!.id);
    } else if (cands.length === 0) {
      semPar.push(rast);
    } else {
      ambiguos.push(rast);
    }
  }

  console.log("=== PARES DUPLICADOS (RAST-* ↔ DETRAN) ===");
  for (const { rast, detran } of matches) {
    console.log(
      `${rast.veiculoId.padEnd(9)} | ${diaDe(detran.dataAutuacao)} ${horaDe(detran)} | R$ ${detran.valorMulta} | RAST-${rast.rastreameId} → ${detran.autoInfracao} | "${detran.descricao.slice(0, 40)}"`,
    );
  }
  console.log(`\nTotal de pares: ${matches.length}`);
  if (ambiguos.length) {
    console.log(`\n=== AMBÍGUOS (vários candidatos, NÃO mexidos) ===`);
    for (const r of ambiguos) {
      console.log(`RAST-${r.rastreameId} | ${r.veiculoId} | ${r.dataAutuacao} | R$ ${r.valorMulta} | "${r.descricao}"`);
    }
  }
  if (semPar.length) {
    console.log(`\n=== RAST-* SEM PAR no DETRAN (mantidos) ===`);
    for (const r of semPar) {
      console.log(`RAST-${r.rastreameId} | ${r.veiculoId} | ${r.dataAutuacao} | R$ ${r.valorMulta} | "${r.descricao}"`);
    }
  }

  if (!apply) {
    console.log(`\n(dry-run — nada gravado. Use --apply para reconciliar.)`);
    return;
  }

  for (const { rast, detran } of matches) {
    // Move o vínculo do Rastreame para o registro do DETRAN.
    detran.rastreameId = rast.rastreameId;
    detran.rastreameMotoristaKey = rast.rastreameMotoristaKey ?? detran.rastreameMotoristaKey ?? null;
    detran.rastreameRastreavelKey = rast.rastreameRastreavelKey ?? detran.rastreameRastreavelKey ?? null;
    detran.rastreameDataIso = rast.rastreameDataIso ?? detran.rastreameDataIso ?? null;
    detran.rastreameTipo = rast.rastreameTipo ?? "MULTA";
    detran.rastreameSyncEm = null; // força re-push (renomeia o título no Rastreame)
    if (rast.paga === true) {
      detran.paga = true;
      detran.pagaEm = rast.pagaEm ?? detran.pagaEm ?? null;
    }
    if (!detran.condutorId && rast.condutorId) detran.condutorId = rast.condutorId;
    detran.atualizadoEm = new Date().toISOString();

    // Desliga o espelho local SEM inativar o gasto no Rastreame (rastreameId já removido).
    rast.rastreameId = null;
    rast.rastreameSyncEm = null;
    rast.ativo = false;
    rast.atualizadoEm = new Date().toISOString();
  }

  saveClienteDespesasDb(db);
  console.log(`\n[OK] ${matches.length} pares reconciliados. Espelhos RAST-* inativados.`);
  console.log(`Próximo passo: backfill de títulos e 'sync-gastos-gerais' (push) para renomear no Rastreame.`);
}

main();
