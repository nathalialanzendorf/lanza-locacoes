#!/usr/bin/env node
/**
 * Ponto único de entrada para ferramentas Lanza (TypeScript).
 *
 * Na raiz do repositório (após `npm install`):
 *   npm run lanza -- <comando> [args...]
 *   .\\scripts\\lanza.ps1 <comando> [args...]
 */
async function run(): Promise<void> {
  const cmd = process.argv[2];
  const rest = process.argv.slice(3);

  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(`Uso: npm run lanza -- <comando> [args...]
  (alternativa: .\\scripts\\lanza.ps1 <comando> [args...])

Comandos:
  merge-veiculo <novo.json> <dono>
  merge-cliente <cliente.json>
  gravar-despesa <categoria> <valor> <data> <placa> [descricao]
  gravar-despesa baixa <placa> <categoria> [competencia] [data] [--desfazer]  (quita/reabre débito p/ lembrete de vencidos)
  gravar-rastreador [--desde MM/AAAA] [--ate MM/AAAA] [--dry-run]   (alias: sync-rastreador)
  sync-seguro <boletos.json> | sync-seguro --ano 2025 --ano 2026 [--out JSON]
  montar-relatorio <entrada.json>
  rastreame login [--save] | rastreame check <cnh> [nome] | rastreame add <cliente.json>
  rastreame-gastos list [--page 0] [--size 50] | post <corpo.json> | put <id> <corpo.json>
  baixa-recebimento plano --cliente NOME --valor R$ --data DD/MM/AAAA [--hora HH:MM] [--comprovante T] [--json]
  baixa-recebimento pagbank [--inicio YYYY-MM-DD] [--fim YYYY-MM-DD] [--json]
  pagbank check | pagbank creditos list [--inicio YYYY-MM-DD] [--fim YYYY-MM-DD] [--json] | pagbank match [--inicio] [--fim] [--json]
  rastreame-lancar-semanal [--inicio YYYY-MM-DD] [--fim YYYY-MM-DD] [--prazo-dias N] [--execute]
  fipe marca <texto> | fipe modelos <code> [filtros...] | fipe anos ... | fipe valor ...
  atualizar-fipe-veiculos [--placa PLACA]
  sincronizar-veiculos-crlv [--dry-run] [--placa PLACA]
  importar-clientes-rastreame [--dry-run]
  importar-clientes-cnh [--raiz DIR] [--dry-run] [--com-rastreame]
  cadastro-contrato gerar | sincronizar | encerrar | excluir  (ver --help)
  importar-contratos [RAIZ] [--dry-run]   (varre pastas DD.MM.AAAA - Nome)
  relatorio-encerramento-contrato <pasta> --encerramento DD/MM/AAAA | <entrada.json>
  relatorio-cobrancas [tipo-lote|tipo-placa] [--placa PLACA] [--tipo TIPO] [--listar] …
  gravar-cliente-despesa <lote.json> | gravar-cliente-despesa confirmar <autoInfracao> [condutorId]
  atribuir-condutores [--placa PLACA] [--dry-run] [--prazo-dias N] [--incluir-pedagios]  (concilia condutor por vigência; sem contrato → Não identificado)
  sync-detran-sc [--placa PLACA] [--dry-run] [--ticket UUID] [--json resposta.json]  (Infrações, IPVA e Licenciamento DETRAN SC, ufRegistro="SC")
  detran-sc-solver [--placa PLACA] [--dry-run] [--so-token]  (login + solver de captcha Turnstile em Chrome real; varre a frota SC)
  sync-detran-rs [--placa PLACA] [--dry-run] [--json resposta.json]  (Infrações, IPVA e Licenciamento DETRAN RS, ufRegistro="RS")
  sync-infracoes [--placa PLACA] [--dry-run] [--ticket UUID] [--json resposta.json]  (infrações; roteia RS p/ tool detran-rs)
  sync-ipva-licenciamento [--placa PLACA] [--dry-run] [--ticket UUID] [--json resposta.json]  (IPVA/Lic.; roteia RS p/ tool detran-rs)
  inicio-locacoes <derivar|listar> [--sobrescrever] [--dry-run]
  locacoes <add|listar|excluir> [opções]   (períodos de locação/reserva/manutenção por veículo)
  sync-pedagios [--placa PLACA] [--dry-run] [--json resposta.json]
  pedagio-digital register --placa PLACA [--modelo X] | veiculos | passagens --placa PLACA [--status aberto|pago]
  sync-gastos-gerais [--dry-run] [--pull-only] [--push-only] [--force-pull] [--motorista KEY]  (alias: sync-recebimentos)
  sync-manutencao [--placa PLACA] [--categoria CAT] [--dry-run]  (despesa parceiro → tela Manutenção)
  sync-rastreaveis [--dry-run] [--pull-only] [--push-only] [--force-pull] [--no-fipe]
  sync-motoristas [--dry-run] [--pull-only] [--push-only] [--force-pull]
  renegociar-debitos resumo --motorista <key> --rastreavel <key>
  renegociar-debitos <entrada.json> [--execute]
  relatorio-analise-cadastro --cpf CPF --nome "NOME" --nascimento DD/MM/AAAA --base-legal "TEXTO" [--bnmp|--pf|--tjsc] [--aprovar|--reprovar] [--cliente id|cpf] [--timeout-min N] [--sem-browser] [--out] [--json]  (antecedentes/processos em Chrome real; exige base legal LGPD; grava em database/analise-cadastro.json e espelha no cliente)
  relatorio-analise-cadastro --listar [--cpf CPF] [--com-alerta] [--json]  (histórico de análises de cadastro gravadas)
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
      await (await import("./cli/mergeCliente.js")).main(rest);
      break;
    case "gravar-despesa":
      (await import("./cli/gravarDespesa.js")).main(rest);
      break;
    case "sync-seguro":
      await (await import("./cli/syncSeguro.js")).main(rest);
      break;
    case "gravar-rastreador":
    case "sync-rastreador":
      (await import("./cli/gravarRastreador.js")).main(rest);
      break;
    case "montar-relatorio":
      (await import("./cli/montarRelatorio.js")).main(rest);
      break;
    case "rastreame-gastos":
      await (await import("./cli/rastreameGastos.js")).main(rest);
      break;
    case "baixa-recebimento":
      await (await import("./cli/baixaRecebimento.js")).main(rest);
      break;
    case "pagbank":
      await (await import("./cli/pagbank.js")).main(rest);
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
        await (await cadastroContrato()).main(["sincronizar", ...rest]);
      } else {
        await (await cadastroContrato()).main(rest);
      }
      break;
    case "importar-contratos":
      await (await import("./cli/importarContratos.js")).main(rest);
      break;
    case "registrar-encerramento-contrato":
      if (rest.length >= 2 && rest.includes("--encerramento")) {
        const pasta = rest.find((a) => !a.startsWith("-")) ?? rest[0]!;
        const idx = rest.indexOf("--encerramento");
        const data = rest[idx + 1]!;
        await (await cadastroContrato()).main([
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
    case "relatorio-cobrancas":
    case "cobrancas":
      (await import("./cli/relatorioCobrancas.js")).main(rest);
      break;
    case "gravar-cliente-despesa":
    case "gravar-infracao":
      await (await import("./cli/gravarClienteDespesa.js")).main(rest);
      break;
    case "sync-infracoes":
      await (await import("./cli/syncInfracoes.js")).main(rest);
      break;
    case "atribuir-condutores":
      (await import("./cli/atribuirCondutores.js")).main(rest);
      break;
    case "inicio-locacoes":
      await (await import("./cli/inicioLocacoes.js")).main(rest);
      break;
    case "locacoes":
    case "locacao":
      (await import("./cli/locacoes.js")).main(rest);
      break;
    case "sync-ipva-licenciamento":
      await (await import("./cli/syncIpvaLicenciamento.js")).main(rest);
      break;
    case "sync-detran-sc": {
      // Guarda-chuva SC-only: o mesmo ticket/JSON serve para infrações e IPVA/Lic.
      // (a resposta-consulta traz tudo). --no-rs evita rodar o RS em duplicado.
      const scArgs = rest.includes("--no-rs") ? rest : [...rest, "--no-rs"];
      console.log("== DETRAN SC: infrações ==");
      await (await import("./cli/syncInfracoes.js")).main(scArgs);
      console.log("\n== DETRAN SC: IPVA / Licenciamento ==");
      await (await import("./cli/syncIpvaLicenciamento.js")).main(scArgs);
      break;
    }
    case "sync-detran-rs":
      await (await import("./cli/syncDetranRs.js")).main(rest);
      break;
    case "detran-sc-solver":
    case "detran-solver":
      // Solver de captcha (Turnstile) + login: roda num Chrome real via CDP.
      // Mora em scripts/ porque depende de Chrome/CDP (não é um sync puro).
      await import("../scripts/detranSolver.js");
      break;
    case "sync-pedagios":
      await (await import("./cli/syncPedagios.js")).main(rest);
      break;
    case "pedagio-digital":
      await (await import("./cli/pedagioDigital.js")).main(rest);
      break;
    case "sync-gastos-gerais":
    case "sync-recebimentos":
      await (await import("./cli/syncRecebimentos.js")).main(rest);
      break;
    case "sync-manutencao":
      await (await import("./cli/syncManutencao.js")).main(rest);
      break;
    case "sync-rastreaveis":
      await (await import("./cli/syncRastreaveis.js")).main(rest);
      break;
    case "sync-motoristas":
      await (await import("./cli/syncMotoristas.js")).main(rest);
      break;
    case "renegociar-debitos":
      await (await import("./cli/renegociarDebitos.js")).main(rest);
      break;
    case "relatorio-analise-cadastro":
      await (await import("./cli/relatorioAnaliseCadastro.js")).main(rest);
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
