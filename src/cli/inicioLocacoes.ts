import {
  derivarInicioLocacoes,
  gravarInicioLocacoesDerivado,
} from "../lib/inicioLocacoes.js";

export async function main(argv: string[]): Promise<void> {
  const sub = argv[0];
  const dryRun = argv.includes("--dry-run");
  const sobrescrever = argv.includes("--sobrescrever");

  if (sub === "-h" || sub === "--help") {
    console.log(`inicio-locacoes <derivar|listar> [--sobrescrever] [--dry-run]

  derivar   Grava em veiculos.json (campo inicioLocacoes) a data da 1ª locação
            registrada de cada placa (cliente-despesas.json).
            Por padrão só preenche placas SEM o campo; use --sobrescrever para
            recalcular todas. --dry-run mostra sem gravar.
  listar    Mostra a data derivada por placa (não grava).`);
    return;
  }

  if (sub === "listar") {
    const m = derivarInicioLocacoes();
    const linhas = [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [placa, data] of linhas) console.log(`${placa.padEnd(8)} ${data}`);
    console.log(`\nTotal placas com locação: ${linhas.length}`);
    return;
  }

  // default: derivar
  const res = gravarInicioLocacoesDerivado({ sobrescrever, dryRun });
  for (const r of res) {
    console.log(`[${r.acao}] ${r.placa.padEnd(8)} ${r.inicio || "—"}`);
  }
  const def = res.filter((r) => r.acao === "definido").length;
  const upd = res.filter((r) => r.acao === "atualizado").length;
  const keep = res.filter((r) => r.acao === "mantido").length;
  const none = res.filter((r) => r.acao === "sem-dados").length;
  console.log(
    `\n${dryRun ? "[dry-run] " : ""}definidos: ${def} | atualizados: ${upd} | mantidos: ${keep} | sem dados: ${none}`,
  );
}
