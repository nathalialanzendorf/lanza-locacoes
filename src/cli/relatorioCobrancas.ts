import {
  gerarSemanal,
  gerarEstacionamento,
  gerarMultas,
  salvarCobranca,
  salvarCobrancasDados,
  type ResultadoCobranca,
  type TipoCobranca,
} from "../lib/cobrancas.js";
import { mainSemanalAtraso } from "./relatorioCobrancasSemanalAtraso.js";
import { mainLote } from "./relatorioCobrancasLote.js";

const MODOS_POR_PLACA = new Set([
  "semanal",
  "semanal-atraso",
  "estacionamento",
  "multa",
]);

function getOpt(argv: string[], nome: string): string | undefined {
  const i = argv.indexOf(nome);
  return i >= 0 ? argv[i + 1] : undefined;
}

function uso(): void {
  console.log(`Uso: relatorio-cobrancas [tipo-despesa] [opções]

Lote (omitir parâmetro = todos nessa dimensão):
  tipo-despesa   pagamento-semanal | renegociacao | infracoes | pedagio | estacionamento-rotativo | manutencao
  --cliente      filtra locatário (omitir = todos)
  --placa        filtra veículo (omitir = todos)

Modo por placa (legado):
  semanal | semanal-atraso | estacionamento | multa  — exige --placa

Opções: --listar · --dia N · --data-pagamento · --no-salvar · --out DIR · --nome · --auto

Exemplos:
  relatorio-cobrancas
  relatorio-cobrancas pagamento-semanal --cliente "Daniel Damasceno"
  relatorio-cobrancas --tipo infracoes --placa QJB-0I83
  relatorio-cobrancas semanal-atraso --placa RAH-4F54 --data-pagamento 30/06/2026
`);
}

export function main(argv: string[]): void {
  if (argv.includes("-h") || argv.includes("--help")) {
    uso();
    process.exit(0);
  }

  const tipoArg = argv[0];

  if (tipoArg === "semanal-atraso") {
    mainSemanalAtraso(argv.slice(1));
    return;
  }

  if (tipoArg && MODOS_POR_PLACA.has(tipoArg)) {
    const placa = getOpt(argv, "--placa");
    if (!placa) {
      console.error("Erro: --placa é obrigatório.");
      uso();
      process.exit(1);
    }

    const salvar = !argv.includes("--no-salvar");
    const outDir = getOpt(argv, "--out");
    const nome = getOpt(argv, "--nome");
    const tipo = tipoArg;

    let resultados: ResultadoCobranca[] = [];

    switch (tipo) {
      case "semanal": {
        const dia = Number(getOpt(argv, "--dia") ?? 1);
        if (![1, 2, 3, 4].includes(dia)) {
          console.error("Erro: --dia deve ser 1, 2, 3 ou 4.");
          process.exit(1);
        }
        resultados = [gerarSemanal(placa, dia, { nome })];
        break;
      }
      case "estacionamento":
        resultados = [gerarEstacionamento(placa, { nome })];
        break;
      case "multa": {
        const auto = getOpt(argv, "--auto");
        resultados = gerarMultas(placa, { auto, nome });
        if (resultados.length === 0) {
          console.error(
            `Nenhuma infração em aberto para ${placa}` +
              (auto ? ` (auto ${auto})` : "") +
              ". Rode sync-infracoes antes, ou confira cliente-despesas.json.",
          );
          process.exit(1);
        }
        break;
      }
      default:
        console.error("Tipo desconhecido:", tipo);
        uso();
        process.exit(1);
    }

    const salvos: string[] = [];
    for (const r of resultados) {
      console.log("\n" + "─".repeat(40));
      console.log(r.texto);
      if (salvar) salvos.push(salvarCobranca(r, outDir));
    }

    if (salvos.length) {
      console.log("\n[arquivos gerados]");
      for (const s of salvos) console.log(`  ${s}`);
    }

    if (salvar && resultados.length) {
      const jsonPath = salvarCobrancasDados(
        resultados,
        tipo as TipoCobranca,
        placa,
        outDir,
      );
      console.log(`\n[dados p/ canvas]\n  ${jsonPath}`);
    }
    return;
  }

  mainLote(argv);
}
