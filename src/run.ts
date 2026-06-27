#!/usr/bin/env node
/**
 * Ponto único de entrada para ferramentas Lanza (TypeScript).
 *
 * Na raiz do repositório (após `npm install`):
 *   npx tsx src/run.ts <comando> [args...]
 */
async function run(): Promise<void> {
  const cmd = process.argv[2];
  const rest = process.argv.slice(3);

  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(`Uso: npx tsx src/run.ts <comando> [args...]

Comandos:
  merge-veiculo <novo.json> <dono>
  merge-cliente <cliente.json>
  gravar-despesa <categoria> <valor> <data> <placa> [descricao]
  sync-seguro <boletos.json> | sync-seguro --ano 2025 --ano 2026 [--out JSON]
  montar-relatorio <entrada.json>
  rastreame check <cnh> [nome] | rastreame add <cliente.json>
  rastreame-gastos list [--page 0] [--size 50] | post <corpo.json> | put <id> <corpo.json>
  rastreame-lancar-semanal [--inicio YYYY-MM-DD] [--fim YYYY-MM-DD] [--prazo-dias N] [--execute]
  fipe marca <texto> | fipe modelos <code> [filtros...] | fipe anos ... | fipe valor ...
  atualizar-fipe-veiculos [--placa PLACA]
  sincronizar-veiculos-crlv [--dry-run] [--placa PLACA]
  importar-clientes-rastreame [--dry-run]
  importar-clientes-cnh [--raiz DIR] [--dry-run] [--com-rastreame]
  cadastro-contrato gerar | sincronizar | encerrar | excluir  (ver --help)
  relatorio-encerramento-contrato <pasta> --encerramento DD/MM/AAAA | <entrada.json>
  gravar-cliente-despesa <lote.json> | gravar-cliente-despesa confirmar <autoInfracao> [condutorId]
  sync-infracoes [--placa PLACA] [--dry-run] [--ticket UUID] [--json resposta.json]
  sync-ipva-licenciamento [--placa PLACA] [--dry-run] [--ticket UUID] [--json resposta.json]
  sync-recebimentos [--dry-run] [--pull-only] [--push-only] [--force-pull] [--motorista KEY]
  sync-rastreaveis [--dry-run] [--pull-only] [--push-only] [--force-pull]
  renegociar-debitos resumo --motorista <key> --rastreavel <key>
  renegociar-debitos <entrada.json> [--execute]
`);
    process.exit(cmd ? 0 : 1);
  }

  const cadastroContrato = () => import("./cli/cadastroContrato.js");
  const relatorioEncerramento = () => import("./cli/relatorioEncerramentoContrato.js");

  switch (cmd) {
    case "merge-veiculo":
      await (await import("./cli/mergeVeiculo.js")).main(rest);
      break;
    case "merge-cliente":
      (await import("./cli/mergeCliente.js")).main(rest);
      break;
    case "gravar-despesa":
      (await import("./cli/gravarDespesa.js")).main(rest);
      break;
    case "sync-seguro":
      await (await import("./cli/syncSeguro.js")).main(rest);
      break;
    case "montar-relatorio":
      (await import("./cli/montarRelatorio.js")).main(rest);
      break;
    case "rastreame-gastos":
      await (await import("./cli/rastreameGastos.js")).main(rest);
      break;
    case "rastreame":
      await (await import("./cli/rastreame.js")).main(rest);
      break;
    case "rastreame-lancar-semanal":
      await (await import("./cli/rastreameLancarSemanal.js")).main(rest);
      break;
    case "fipe":
      await (await import("./cli/fipe.js")).main(rest);
      break;
    case "atualizar-fipe-veiculos":
      await (await import("./cli/atualizarFipeVeiculos.js")).main(rest);
      break;
    case "sincronizar-veiculos-crlv":
      await (await import("./cli/sincronizarVeiculosCrlv.js")).main(rest);
      break;
    case "importar-clientes-cnh":
      await (await import("./cli/importarClientesCnh.js")).main(rest);
      break;
    case "importar-clientes-rastreame":
      await (await import("./cli/importarClientesRastreame.js")).main(rest);
      break;
    case "cadastro-contrato":
    case "gerar-contrato":
    case "registrar-contrato":
      if (cmd === "registrar-contrato") {
        (await cadastroContrato()).main(["sincronizar", ...rest]);
      } else {
        (await cadastroContrato()).main(rest);
      }
      break;
    case "registrar-encerramento-contrato":
      if (rest.length >= 2 && rest.includes("--encerramento")) {
        const pasta = rest.find((a) => !a.startsWith("-")) ?? rest[0]!;
        const idx = rest.indexOf("--encerramento");
        const data = rest[idx + 1]!;
        (await cadastroContrato()).main([
          "encerrar",
          pasta,
          "--data",
          data,
          "--motivo",
          "devolvido",
          "--quebra",
        ]);
      } else {
        console.error(
          "Use: cadastro-contrato encerrar <pasta> --data DD/MM/AAAA --motivo devolvido|recuperado",
        );
        process.exit(1);
      }
      break;
    case "relatorio-encerramento-contrato":
    case "encerrar-contrato":
      (await relatorioEncerramento()).main(rest);
      break;
    case "gravar-cliente-despesa":
    case "gravar-infracao":
      await (await import("./cli/gravarClienteDespesa.js")).main(rest);
      break;
    case "sync-infracoes":
      await (await import("./cli/syncInfracoes.js")).main(rest);
      break;
    case "sync-ipva-licenciamento":
      await (await import("./cli/syncIpvaLicenciamento.js")).main(rest);
      break;
    case "sync-recebimentos":
      await (await import("./cli/syncRecebimentos.js")).main(rest);
      break;
    case "sync-rastreaveis":
      await (await import("./cli/syncRastreaveis.js")).main(rest);
      break;
    case "renegociar-debitos":
      await (await import("./cli/renegociarDebitos.js")).main(rest);
      break;
    default:
      console.error("Comando desconhecido:", cmd);
      process.exit(1);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
