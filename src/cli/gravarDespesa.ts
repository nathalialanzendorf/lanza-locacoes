import {
  gravarParceiroDespesaManual,
  marcarBaixaParceiroDespesa,
} from "../lib/parceiroDespesasDb.js";

function baixa(argv: string[]): void {
  const desfazer = argv.includes("--desfazer");
  const pos = argv.filter((a) => !a.startsWith("--"));
  // baixa <placa> <categoria> [competencia] [data]   |   baixa --id <id> [data]
  const idIdx = argv.indexOf("--id");
  const seletor =
    idIdx >= 0
      ? { id: argv[idIdx + 1] }
      : { placa: pos[0], categoria: pos[1], competencia: pos[2] };
  const data = idIdx >= 0 ? pos[0] : pos[3];

  if (!seletor.id && !seletor.placa) {
    console.error(
      "Uso: gravar-despesa baixa <placa> <categoria> [competencia MM/AAAA] [data DD/MM/AAAA] [--desfazer]\n" +
        "     gravar-despesa baixa --id <id> [data] [--desfazer]",
    );
    process.exit(1);
  }

  const r = marcarBaixaParceiroDespesa(seletor, { data, desfazer });
  if (!r.atualizados.length && !r.semAlteracao.length) {
    console.log("Nenhuma despesa encontrada para o seletor informado.");
    return;
  }
  const verbo = desfazer ? "reaberta" : "baixada";
  for (const d of r.atualizados) {
    console.log(
      `${verbo}: ${d.categoria} R$ ${d.valor.toFixed(2)} ${d.competencia} -> ${d.placa}` +
        (desfazer ? "" : ` (baixa ${d.baixa})`),
    );
  }
  for (const d of r.semAlteracao) {
    console.log(
      `sem alteração: ${d.categoria} ${d.competencia} -> ${d.placa} (já ${desfazer ? "em aberto" : "baixada"})`,
    );
  }
}

export function main(argv: string[]): void {
  if (argv[0] === "baixa") {
    baixa(argv.slice(1));
    return;
  }

  const categoria = argv[0]!;
  const valorRaw = argv[1]!;
  const data = argv[2]!;
  const placa = argv[3]!;
  const descricao = argv[4] ?? categoria;

  const r = gravarParceiroDespesaManual({
    placa,
    categoria,
    descricao,
    data,
    valor: valorRaw,
  });

  const aviso = r.aviso ? `  (${r.aviso})` : "";
  const dup = r.acao === "sem_alteracao" ? " [já existia]" : "";
  console.log(
    `Despesa ${r.acao}: ${r.registro.categoria} R$ ${r.registro.valor.toFixed(2)} em ${r.registro.data} -> ${r.registro.placa}${dup}${aviso}`,
  );
}
