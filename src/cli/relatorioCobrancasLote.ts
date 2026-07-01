/**
 * CLI: cobranças em lote por tipo (actions).
 */
import {
  executarLoteCobranca,
  listarResumoAlvos,
  salvarLoteConsolidado,
} from "../lib/cobrancasLote.js";
import {
  normalizarTipoCobrancaAction,
  TIPOS_COBRANCA_ACTION,
  type FiltroAlvosCobranca,
  type TipoCobrancaAction,
} from "../lib/cobrancasAlvos.js";
import { COBRANCAS_OUT_DIR } from "../lib/cobrancas.js";
import { loadClientesDb } from "../lib/clientesDb.js";
import { resolverCliente } from "../lib/recebimento/baixaPlano.js";

function getOpt(argv: string[], nome: string): string | undefined {
  const i = argv.indexOf(nome);
  return i >= 0 ? argv[i + 1] : undefined;
}

function brl(n: number): string {
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function listarTiposCobranca(): void {
  console.log(`Tipos de despesa em cobrança (omitir = todos):

  pagamento-semanal       Semanas ATRASADO em aberto (+ tabela dia a dia)
  renegociacao            Parcelas de renegociação em aberto
  infracoes               Infrações de trânsito em aberto
  pedagio                 Pedágio em aberto
  estacionamento-rotativo Estacionamento em aberto
  manutencao              Manutenção em aberto

Parâmetros opcionais (omitir = todos): --tipo · --cliente · --placa
`);
}

function rotuloTipos(tipos: TipoCobrancaAction[]): string {
  if (tipos.length === TIPOS_COBRANCA_ACTION.length) return "todos os tipos";
  if (tipos.length === 1) return tipos[0]!;
  return tipos.join(", ");
}

function resolverFiltro(argv: string[]): FiltroAlvosCobranca {
  const placa = getOpt(argv, "--placa");
  const clienteQuery = getOpt(argv, "--cliente");
  if (placa && clienteQuery) {
    console.error("Erro: use --placa OU --cliente, não ambos.");
    process.exit(1);
  }
  if (clienteQuery) {
    const c = resolverCliente(clienteQuery);
    if (!c.id) {
      console.error("Cliente sem id em clientes.json:", c.nome);
      process.exit(1);
    }
    return { clienteId: c.id };
  }
  if (placa) return { placa };
  return {};
}

function rotuloFiltro(filtro: FiltroAlvosCobranca): string {
  const partes: string[] = [];
  if (filtro.placa) partes.push(`placa ${filtro.placa}`);
  else if (filtro.clienteId) {
    const c = loadClientesDb().clientes.find((x) => x.id === filtro.clienteId);
    partes.push(c?.nome ? `cliente ${c.nome}` : `cliente ${filtro.clienteId}`);
  } else {
    partes.push("todos os clientes/veículos");
  }
  return partes.join(" · ");
}

function uso(): void {
  console.log(`Uso: relatorio-cobrancas [tipo-despesa] [opções]

Tipos de despesa (omitir = todos):
  pagamento-semanal | renegociacao | infracoes | pedagio | estacionamento-rotativo | manutencao

Opções:
  --tipo TIPO           Filtra um tipo-despesa (ou passe como 1º argumento)
  --cliente NOME/CPF/id Filtra locatário (omitir = todos; exclusivo com --placa)
  --placa PLACA         Filtra veículo (omitir = todos; exclusivo com --cliente)
  --listar              Só lista alvos elegíveis (não gera mensagens)
  --dia N               (pagamento-semanal) dia WhatsApp [padrão 3]
  --data-pagamento DD/MM/AAAA  (pagamento-semanal) data p/ tabela de atraso [hoje]
  --no-salvar           Só imprime no terminal
  --out DIR             Diretório de saída [padrão relatorios/_tmp/cobrancas/]

Sem parâmetros: gera cobrança para todos os tipos, clientes e veículos elegíveis.
`);
}

/** null em tipo inválido; array vazio nunca — omitir tipo = todos. */
function resolverTipos(argv: string[]): TipoCobrancaAction[] | null {
  const fromFlag = getOpt(argv, "--tipo");
  if (fromFlag) {
    const t = normalizarTipoCobrancaAction(fromFlag);
    if (!t) {
      console.error(`Tipo-despesa inválido: ${fromFlag}`);
      return null;
    }
    return [t];
  }
  const first = argv.find((a) => !a.startsWith("-"));
  if (first) {
    const t = normalizarTipoCobrancaAction(first);
    if (t) return [t];
  }
  return [...TIPOS_COBRANCA_ACTION];
}

function imprimirListagem(tipo: TipoCobrancaAction, filtro: FiltroAlvosCobranca): void {
  const alvos = listarResumoAlvos(tipo, filtro);
  console.log(`\nAlvos elegíveis — ${tipo} (${rotuloFiltro(filtro)}): ${alvos.length}\n`);
  if (alvos.length === 0) {
    console.log("  (nenhum)");
    return;
  }
  for (const a of alvos) {
    const nome = a.clienteNome ?? "(sem cliente)";
    const qtd = a.despesas.length;
    const extra =
      tipo === "pagamento-semanal" && a.vencimentosBr?.length
        ? ` · venc.: ${a.vencimentosBr.join(", ")}`
        : tipo === "renegociacao" || tipo === "manutencao"
          ? ` · ${brl(a.despesas.reduce((s, d) => s + (Number(d.valorMulta) || 0), 0))}`
          : "";
    console.log(`  ${a.placa} · ${nome} · ${qtd} despesa(s)${extra}`);
  }
}

export function mainLote(argv: string[]): void {
  if (argv.includes("-h") || argv.includes("--help")) {
    uso();
    process.exit(0);
  }

  const tipos = resolverTipos(argv);
  if (!tipos) {
    uso();
    process.exit(1);
  }

  const filtro = resolverFiltro(argv);
  const apenasListar = argv.includes("--listar");
  const salvar = !argv.includes("--no-salvar");
  const outDir = getOpt(argv, "--out") ?? COBRANCAS_OUT_DIR;
  const dia = Number(getOpt(argv, "--dia") ?? 3);
  const dataPagamento = getOpt(argv, "--data-pagamento");

  if (tipos.includes("pagamento-semanal") && ![1, 2, 3, 4].includes(dia)) {
    console.error("Erro: --dia deve ser 1, 2, 3 ou 4.");
    process.exit(1);
  }

  const cabecalho = `${rotuloTipos(tipos)} · ${rotuloFiltro(filtro)}`;
  console.log(`\n=== Cobrança: ${cabecalho} ===`);

  if (apenasListar) {
    for (const tipo of tipos) {
      imprimirListagem(tipo, filtro);
    }
    process.exit(0);
  }

  let totalAlvos = 0;
  let totalMensagens = 0;
  let totalIgnorados = 0;

  for (const tipo of tipos) {
    const result = executarLoteCobranca(tipo, {
      filtro,
      dia,
      dataPagamentoBr: dataPagamento,
      salvar,
      outDir,
    });

    totalAlvos += result.resumo.alvos;
    totalMensagens += result.resumo.mensagens;
    totalIgnorados += result.resumo.ignorados;

    if (tipos.length > 1) {
      console.log(`\n── ${tipo} ──`);
      console.log(
        `Alvos: ${result.resumo.alvos} · Mensagens: ${result.resumo.mensagens} · Ignorados: ${result.resumo.ignorados}`,
      );
    } else {
      console.log(
        `Alvos: ${result.resumo.alvos} · Mensagens: ${result.resumo.mensagens} · Ignorados: ${result.resumo.ignorados}\n`,
      );
    }

    if (result.items.length === 0) {
      console.log("  (nenhum alvo elegível)");
      continue;
    }

    for (const item of result.items) {
      console.log("─".repeat(48));
      const a = item.alvo;
      console.log(`${a.placa} · ${a.clienteNome ?? "(sem cliente)"}`);
      if (item.aviso) console.log(`  ⚠ ${item.aviso}`);
      if (item.semanalAtraso) {
        console.log(`  Total atraso: ${brl(item.semanalAtraso.totalGeral)}`);
        if (!salvar) {
          console.log("\n" + item.semanalAtraso.markdown);
        }
      }
      for (const r of item.resultados) {
        console.log("\n" + r.texto);
      }
      if (item.arquivos.length) {
        console.log("\n  [arquivos]");
        for (const f of item.arquivos) console.log(`    ${f}`);
      }
    }

    if (salvar && result.items.length) {
      const jsonPath = salvarLoteConsolidado(result, outDir);
      console.log(`\n[lote ${tipo}]\n  ${jsonPath}`);
    }
  }

  if (tipos.length > 1) {
    console.log(
      `\n[total] Alvos: ${totalAlvos} · Mensagens: ${totalMensagens} · Ignorados: ${totalIgnorados}`,
    );
  }

  if (totalAlvos === 0) {
    console.log("\nNenhum alvo elegível encontrado.");
  }
}
