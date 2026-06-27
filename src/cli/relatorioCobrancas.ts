import {
  gerarSemanal,
  gerarEstacionamento,
  gerarPedagio,
  gerarMultas,
  salvarCobranca,
  salvarCobrancasDados,
  type ResultadoCobranca,
  type TipoCobranca,
} from "../lib/cobrancas.js";

function getOpt(argv: string[], nome: string): string | undefined {
  const i = argv.indexOf(nome);
  return i >= 0 ? argv[i + 1] : undefined;
}

function uso(): void {
  console.log(`Uso: relatorio-cobrancas <tipo> --placa PLACA [opções]

Tipos:
  semanal         Cobrança de pagamento semanal (escalonamento por dia)
  estacionamento  Aviso de estacionamento rotativo (SigaPay Área Azul)
  pedagio         Aviso de evasão de pedágio (CCR Via Costeira)
  multa           Aviso de infração de trânsito (uma msg por multa em aberto)

Opções:
  --placa PLACA   Placa do veículo (obrigatório)
  --dia N         (semanal) 1=lembrete, 2=regularização, 3=bloqueio, 4=regularizado [padrão 1]
  --auto AUTO     (multa) filtra um único auto de infração
  --nome NOME     Nome do cliente na saudação (padrão: inferido do contrato/multa)
  --no-salvar     Só imprime no terminal (não grava .txt)
  --out DIR       Diretório de saída [padrão relatorios/cobrancas/]

Exemplos:
  relatorio-cobrancas semanal --placa AVU-6740 --dia 1
  relatorio-cobrancas estacionamento --placa AVU-6740
  relatorio-cobrancas pedagio --placa AVU-6740
  relatorio-cobrancas multa --placa QJB-0I83
`);
}

export function main(argv: string[]): void {
  const tipo = argv[0];
  if (!tipo || tipo === "-h" || tipo === "--help") {
    uso();
    process.exit(tipo ? 0 : 1);
  }

  const placa = getOpt(argv, "--placa");
  if (!placa) {
    console.error("Erro: --placa é obrigatório.");
    uso();
    process.exit(1);
  }

  const salvar = !argv.includes("--no-salvar");
  const outDir = getOpt(argv, "--out");
  const nome = getOpt(argv, "--nome");

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
    case "pedagio":
      resultados = [gerarPedagio(placa, { nome })];
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

  // JSON de dados estruturados (sidecar) — alimenta o canvas.
  if (salvar && resultados.length) {
    const jsonPath = salvarCobrancasDados(
      resultados,
      tipo as TipoCobranca,
      placa,
      outDir,
    );
    console.log(`\n[dados p/ canvas]\n  ${jsonPath}`);
  }
}
