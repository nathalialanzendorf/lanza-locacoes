/**
 * Alvos elegíveis por tipo de cobrança (somente despesas em aberto + frota ativa).
 */
import {
  isClienteDespesaAtiva,
  isInfracaoTransito,
  loadClienteDespesasDb,
  parseRastreameIdFromAuto,
  type ClienteDespesaRegistro,
} from "./clienteDespesasDb.js";
import { loadClientesDb } from "./clientesDb.js";
import { dataVencimentoSemanalBr } from "./pagamentoSemanal.js";
import { compactPlaca, formatPlacaHyphen } from "./placa.js";
import { loadVeiculosDb } from "./veiculosDb.js";

export type TipoCobrancaAction =
  | "pagamento-semanal"
  | "renegociacao"
  | "infracoes"
  | "pedagio"
  | "estacionamento-rotativo"
  | "manutencao";

export const TIPOS_COBRANCA_ACTION: readonly TipoCobrancaAction[] = [
  "pagamento-semanal",
  "renegociacao",
  "infracoes",
  "pedagio",
  "estacionamento-rotativo",
  "manutencao",
] as const;

export type AlvoCobranca = {
  tipo: TipoCobrancaAction;
  placa: string;
  clienteId: string | null;
  clienteNome: string | null;
  /** Despesas em aberto que fundamentam a cobrança. */
  despesas: ClienteDespesaRegistro[];
  /** Vencimentos semanais (pagamento-semanal). */
  vencimentosBr?: string[];
};

function veiculosAtivos() {
  const map = new Map<string, ReturnType<typeof loadVeiculosDb>["veiculos"][0]>();
  for (const v of loadVeiculosDb().veiculos) {
    if (v.ativo === false) continue;
    if (v.particular === true) continue;
    map.set(compactPlaca(v.placa), v);
  }
  return map;
}

function clientesAtivos() {
  const map = new Map<string, { id: string; nome: string }>();
  for (const c of loadClientesDb().clientes) {
    if (c.ativo === false) continue;
    if (c.id) map.set(c.id, { id: c.id, nome: c.nome });
  }
  return map;
}

function despesaAberta(d: ClienteDespesaRegistro): boolean {
  return (
    isClienteDespesaAtiva(d) &&
    d.paga !== true &&
    (d.situacao === "Em aberto" || !d.paga)
  );
}

function placaElegivel(placa: string, veiculos: ReturnType<typeof veiculosAtivos>): boolean {
  return veiculos.has(compactPlaca(placa));
}

function clienteElegivel(
  clienteId: string | null | undefined,
  clientes: ReturnType<typeof clientesAtivos>,
): boolean {
  if (!clienteId) return true;
  return clientes.has(clienteId);
}

function agruparPorPlaca(
  tipo: TipoCobrancaAction,
  despesas: ClienteDespesaRegistro[],
  veiculos: ReturnType<typeof veiculosAtivos>,
  clientes: ReturnType<typeof clientesAtivos>,
): AlvoCobranca[] {
  const porPlaca = new Map<string, ClienteDespesaRegistro[]>();
  for (const d of despesas) {
    if (!placaElegivel(d.veiculoId, veiculos)) continue;
    if (!clienteElegivel(d.condutorId, clientes)) continue;
    const p = formatPlacaHyphen(d.veiculoId);
    const list = porPlaca.get(p) ?? [];
    list.push(d);
    porPlaca.set(p, list);
  }

  const out: AlvoCobranca[] = [];
  for (const [placa, list] of porPlaca) {
    const condutorId = list.find((x) => x.condutorId)?.condutorId ?? null;
    const cliente = condutorId ? clientes.get(condutorId) : null;
    out.push({
      tipo,
      placa,
      clienteId: condutorId,
      clienteNome: cliente?.nome ?? null,
      despesas: list,
    });
  }
  return out.sort((a, b) => a.placa.localeCompare(b.placa));
}

function filtrarPagamentoSemanal(
  db: ReturnType<typeof loadClienteDespesasDb>,
  veiculos: ReturnType<typeof veiculosAtivos>,
  clientes: ReturnType<typeof clientesAtivos>,
  placaFiltro?: string,
): AlvoCobranca[] {
  const alvoPlaca = placaFiltro ? compactPlaca(placaFiltro) : null;
  const porChave = new Map<string, AlvoCobranca>();

  for (const d of db.clienteDespesas) {
    if (!despesaAberta(d)) continue;
    if (d.categoria !== "Locação semanal") continue;
    if (!/ATRASADO/i.test(d.descricao)) continue;
    if (!placaElegivel(d.veiculoId, veiculos)) continue;
    if (!clienteElegivel(d.condutorId, clientes)) continue;
    if (alvoPlaca && compactPlaca(d.veiculoId) !== alvoPlaca) continue;

    const placa = formatPlacaHyphen(d.veiculoId);
    const chave = `${d.condutorId ?? "?"}|${compactPlaca(placa)}`;
    const venc =
      dataVencimentoSemanalBr(d.descricao, d.rastreameDataIso) ?? d.dataAutuacao;
    const cliente = d.condutorId ? clientes.get(d.condutorId) : null;

    let alvo = porChave.get(chave);
    if (!alvo) {
      alvo = {
        tipo: "pagamento-semanal",
        placa,
        clienteId: d.condutorId,
        clienteNome: cliente?.nome ?? null,
        despesas: [],
        vencimentosBr: [],
      };
      porChave.set(chave, alvo);
    }
    alvo.despesas.push(d);
    if (venc && !alvo.vencimentosBr!.includes(venc)) {
      alvo.vencimentosBr!.push(venc);
    }
  }

  return [...porChave.values()]
    .map((a) => ({
      ...a,
      vencimentosBr: [...(a.vencimentosBr ?? [])].sort((x, y) =>
        x.split("/").reverse().join("").localeCompare(y.split("/").reverse().join("")),
      ),
    }))
    .sort((a, b) => a.placa.localeCompare(b.placa));
}

export type FiltroAlvosCobranca = {
  /** Limita a uma placa. */
  placa?: string;
  /** Limita a um cliente (nome, CPF ou id — resolvido em clientes.json). */
  clienteId?: string;
};

function filtrarAlvosPorEscopo(
  alvos: AlvoCobranca[],
  filtro?: FiltroAlvosCobranca,
): AlvoCobranca[] {
  if (!filtro?.placa && !filtro?.clienteId) return alvos;
  return alvos.filter((a) => {
    if (filtro.placa && compactPlaca(a.placa) !== compactPlaca(filtro.placa)) {
      return false;
    }
    if (filtro.clienteId && a.clienteId !== filtro.clienteId) {
      return false;
    }
    return true;
  });
}

export function normalizarTipoCobrancaAction(raw: string): TipoCobrancaAction | null {
  const t = raw.trim().toLowerCase();
  const map: Record<string, TipoCobrancaAction> = {
    "pagamento-semanal": "pagamento-semanal",
    pagamento_semanal: "pagamento-semanal",
    renegociacao: "renegociacao",
    renegociação: "renegociacao",
    infracoes: "infracoes",
    infrações: "infracoes",
    pedagio: "pedagio",
    pedágio: "pedagio",
    "estacionamento-rotativo": "estacionamento-rotativo",
    manutencao: "manutencao",
    manutenção: "manutencao",
  };
  return map[t] ?? null;
}

/** Lista alvos elegíveis para um tipo de cobrança. Sem alvos = array vazio. */
export function listarAlvosCobranca(
  tipo: TipoCobrancaAction,
  filtro?: FiltroAlvosCobranca,
): AlvoCobranca[] {
  const db = loadClienteDespesasDb();
  const veiculos = veiculosAtivos();
  const clientes = clientesAtivos();
  const placaFiltro = filtro?.placa;

  let alvos: AlvoCobranca[];

  if (tipo === "pagamento-semanal") {
    alvos = filtrarPagamentoSemanal(db, veiculos, clientes, placaFiltro);
  } else {
    const categoriaMap: Record<
      Exclude<TipoCobrancaAction, "pagamento-semanal" | "infracoes">,
      string
    > = {
      renegociacao: "Renegociação",
      pedagio: "Pedágio",
      "estacionamento-rotativo": "Estacionamento",
      manutencao: "Manutenção",
    };

    if (tipo === "infracoes") {
      const despesas = db.clienteDespesas.filter((d) => {
        if (!despesaAberta(d)) return false;
        if (!isInfracaoTransito(d)) return false;
        if (d.quitadaDetran === true) return false;
        if (d.origem === "rastreame") return false;
        if (parseRastreameIdFromAuto(d.autoInfracao)) return false;
        if (placaFiltro && compactPlaca(d.veiculoId) !== compactPlaca(placaFiltro)) {
          return false;
        }
        return true;
      });
      alvos = agruparPorPlaca(tipo, despesas, veiculos, clientes);
    } else {
      const categoria =
        categoriaMap[tipo as Exclude<TipoCobrancaAction, "pagamento-semanal" | "infracoes">];
      const despesas = db.clienteDespesas.filter((d) => {
        if (!despesaAberta(d)) return false;
        if ((d.categoria ?? "") !== categoria) return false;
        if (tipo === "manutencao" && d.valorMulta <= 0) return false;
        if (placaFiltro && compactPlaca(d.veiculoId) !== compactPlaca(placaFiltro)) {
          return false;
        }
        return true;
      });
      alvos = agruparPorPlaca(tipo, despesas, veiculos, clientes);
    }
  }

  return filtrarAlvosPorEscopo(alvos, filtro);
}
