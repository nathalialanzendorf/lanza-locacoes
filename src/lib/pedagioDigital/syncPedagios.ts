/**
 * Orquestra: passagens em aberto no pedagiodigital.com → cliente-despesas.json
 * (categoria "Pedágio"), com vínculo de condutor igual ao das infrações e
 * espelho em Gastos Gerais do Rastreame (tipo PEDAGIO) via sync-recebimentos.
 */
import fs from "node:fs";
import path from "node:path";

import {
  sincronizarClienteDespesa,
  type SincronizarClienteDespesaResult,
} from "../clienteDespesasDb.js";
import { compactPlaca, formatPlacaHyphen } from "../placa.js";
import { REPO_ROOT } from "../repoRoot.js";
import { PedagioAuthError } from "./client.js";
import {
  extrairPassagens,
  filtrarStatus,
  listarPassagens,
  listarPassagensLote,
  type PassagemPedagio,
} from "./passagens.js";

export type SyncPedagiosResult = {
  placa: string;
  novos: number;
  atualizados: number;
  semAlteracao: number;
  ignorados: number;
  avisos: string[];
};

const fmtSP = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** Devolve { br: "DD/MM/AAAA HH:mm", traco: "dd-mm-aaaa HH:mm" } a partir da passagem. */
function formatarDatas(p: PassagemPedagio): { br: string; traco: string } | null {
  const raw = p.dataHoraRaw.trim();
  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2}))?/);
  if (m) {
    const [, dd, mm, yyyy, hh = "00", mi = "00"] = m;
    return { br: `${dd}/${mm}/${yyyy} ${hh}:${mi}`, traco: `${dd}-${mm}-${yyyy} ${hh}:${mi}` };
  }
  if (p.dataHoraIso) {
    const parts = fmtSP.formatToParts(new Date(p.dataHoraIso));
    const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "00";
    const dd = get("day");
    const mm = get("month");
    const yyyy = get("year");
    const hh = get("hour");
    const mi = get("minute");
    return { br: `${dd}/${mm}/${yyyy} ${hh}:${mi}`, traco: `${dd}-${mm}-${yyyy} ${hh}:${mi}` };
  }
  return null;
}

function localPassagem(p: PassagemPedagio): string {
  return [p.praca, p.rodovia].filter(Boolean).join(" - ");
}

function aplicarPassagem(
  placa: string,
  p: PassagemPedagio,
  dryRun: boolean,
): { result: SincronizarClienteDespesaResult | null; aviso: string | null } {
  const datas = formatarDatas(p);
  if (!datas) {
    return { result: null, aviso: `passagem ${p.id}: data inválida (${p.dataHoraRaw})` };
  }

  const autoInfracao = `PED-${p.id}`;
  const descricao = `ATRASADO Pagamento pedágio ${datas.traco}`;

  if (dryRun) {
    return {
      result: {
        registro: {
          id: "(dry-run)",
          categoria: "Pedágio",
          veiculoId: formatPlacaHyphen(placa),
          autoInfracao,
          descricao,
          localInfracao: localPassagem(p),
          dataAutuacao: datas.br,
          valorMulta: p.valor,
          situacao: "Em aberto",
          limiteDefesa: "",
          condutorId: null,
          condutorConfirmado: false,
          condutorContrato: null,
          rastreameTipo: "PEDAGIO",
          cadastradoEm: "",
          atualizadoEm: "",
          origem: "pedagio-digital",
        },
        acao: "novo",
        aviso: null,
      },
      aviso: null,
    };
  }

  const r = sincronizarClienteDespesa(placa, {
    autoInfracao,
    descricao,
    localInfracao: localPassagem(p),
    dataAutuacao: datas.br,
    valorMulta: p.valor,
    situacao: "Em aberto",
    limiteDefesa: "",
    categoria: "Pedágio",
    origem: "pedagio-digital",
    rastreameTipo: "PEDAGIO",
  });
  return { result: r, aviso: r.aviso };
}

/** Processa passagens já obtidas (online ou offline) gravando as em aberto. */
export function processarPassagens(
  placa: string,
  passagens: PassagemPedagio[],
  opts?: { dryRun?: boolean },
): SyncPedagiosResult {
  const result: SyncPedagiosResult = {
    placa: formatPlacaHyphen(placa),
    novos: 0,
    atualizados: 0,
    semAlteracao: 0,
    ignorados: 0,
    avisos: [],
  };

  for (const p of filtrarStatus(passagens, "aberto")) {
    const { result: r, aviso } = aplicarPassagem(placa, p, opts?.dryRun === true);
    if (!r) {
      result.ignorados++;
      if (aviso) result.avisos.push(aviso);
      continue;
    }
    if (r.acao === "novo") result.novos++;
    else if (r.acao === "atualizado") result.atualizados++;
    else result.semAlteracao++;
    if (aviso) result.avisos.push(`${r.registro.autoInfracao}: ${aviso}`);
  }

  return result;
}

/** Distância de Hamming (Infinity se comprimentos diferentes). */
function hamming(a: string, b: string): number {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/**
 * Mapa `placaAntiga` (compacta) → `placa` atual (compacta), a partir de
 * `veiculos.json`. O pedágio às vezes registra a passagem pela placa
 * pré-Mercosul (ex.: OWN3259 → OWN3C59, QJB0883 → QJB0I83); o vínculo por
 * `placaAntiga` é determinístico (melhor que heurística).
 */
function loadAliasesPlaca(): Map<string, string> {
  const m = new Map<string, string>();
  try {
    const p = path.join(REPO_ROOT, "database", "veiculos.json");
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as {
      veiculos?: { placa?: string; placaAntiga?: string; ativo?: boolean }[];
    };
    for (const v of j.veiculos ?? []) {
      if (v.ativo === false || !v.placa || !v.placaAntiga) continue;
      m.set(compactPlaca(v.placaAntiga), compactPlaca(v.placa));
    }
  } catch {
    // sem aliases: segue só com match exato/Hamming
  }
  return m;
}

/**
 * Resolve a placa registrada na passagem para a placa cadastrada da frota:
 * 1) match exato; 2) `placaAntiga` (determinístico); 3) única placa da frota a
 * distância de Hamming 1 (fallback). Sem correspondência, mantém a lida.
 */
function resolverPlacaFrota(
  lida: string,
  frotaCompact: string[],
  aliases: Map<string, string>,
): string {
  if (frotaCompact.includes(lida)) return lida;
  const alias = aliases.get(lida);
  if (alias) return alias;
  const candidatos = frotaCompact.filter((p) => hamming(p, lida) === 1);
  return candidatos.length === 1 ? candidatos[0]! : lida;
}

/**
 * Agrupa passagens (de várias placas) por placa compacta. Com `frota`,
 * religa placas registradas pela placa antiga/mal lida ao veículo cadastrado.
 */
function agruparPorPlaca(
  passagens: PassagemPedagio[],
  frota?: string[],
): Map<string, PassagemPedagio[]> {
  const frotaCompact = (frota ?? []).map(compactPlaca).filter(Boolean);
  const aliases = frotaCompact.length ? loadAliasesPlaca() : new Map<string, string>();
  const m = new Map<string, PassagemPedagio[]>();
  for (const p of passagens) {
    const lida = compactPlaca(p.placa);
    if (!lida) continue;
    const k = frotaCompact.length ? resolverPlacaFrota(lida, frotaCompact, aliases) : lida;
    const arr = m.get(k);
    if (arr) arr.push(p);
    else m.set(k, [p]);
  }
  return m;
}

/** Lê um JSON capturado (DevTools) e processa UMA placa, sem chamar a API. */
export function processarPassagensJson(
  placa: string,
  jsonPath: string,
  opts?: { dryRun?: boolean },
): SyncPedagiosResult {
  const raw = JSON.parse(fs.readFileSync(path.resolve(jsonPath), "utf8"));
  const alvo = compactPlaca(placa);
  const passagens = extrairPassagens(raw).filter((p) => compactPlaca(p.placa) === alvo);
  return processarPassagens(placa, passagens, opts);
}

/**
 * Lê um JSON capturado (resposta de `list-logado`, com várias placas) e processa
 * todas as placas ATIVAS da frota — sem chamar a API (não depende da sessão).
 */
export function processarPassagensJsonLote(
  jsonPath: string,
  opts?: { dryRun?: boolean; placa?: string },
): SyncPedagiosResult[] {
  const raw = JSON.parse(fs.readFileSync(path.resolve(jsonPath), "utf8"));
  const placas = loadPlacasParaSync(opts?.placa);
  const porPlaca = agruparPorPlaca(extrairPassagens(raw), placas);
  return placas.map((placa) =>
    processarPassagens(placa, porPlaca.get(compactPlaca(placa)) ?? [], {
      dryRun: opts?.dryRun,
    }),
  );
}

/** Consulta o portal e grava as passagens em aberto de uma placa. */
export async function sincronizarPedagiosVeiculo(
  placa: string,
  opts?: { dryRun?: boolean },
): Promise<SyncPedagiosResult> {
  const passagens = await listarPassagens(placa, { status: "aberto" });
  return processarPassagens(placa, passagens, opts);
}

function loadPlacasFrota(placaFiltro?: string): string[] {
  const p = path.join(REPO_ROOT, "database", "veiculos.json");
  const j = JSON.parse(fs.readFileSync(p, "utf8")) as {
    veiculos?: { placa?: string; ativo?: boolean }[];
  };
  const filtro = placaFiltro ? formatPlacaHyphen(placaFiltro) : null;
  return (j.veiculos ?? [])
    // Sincroniza apenas veículos ATIVOS (ignora vendidos/inativos).
    .filter((v) => v.ativo !== false)
    .map((v) => v.placa)
    .filter((p): p is string => !!p)
    .filter((p) => !filtro || formatPlacaHyphen(p) === filtro);
}

export function loadPlacasParaSync(placaFiltro?: string): string[] {
  const list = loadPlacasFrota(placaFiltro);
  if (placaFiltro && list.length === 0) {
    const p = path.join(REPO_ROOT, "database", "veiculos.json");
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as {
      veiculos?: { placa?: string; ativo?: boolean }[];
    };
    const alvo = formatPlacaHyphen(placaFiltro);
    const existe = (j.veiculos ?? []).find(
      (v) => v.placa && formatPlacaHyphen(v.placa) === alvo,
    );
    if (existe) {
      throw new Error(`Placa ${alvo} está inativa em veiculos.json — sync ocorre só para ativos.`);
    }
    throw new Error(`Placa não encontrada em veiculos.json: ${placaFiltro}`);
  }
  return list;
}

/**
 * Sincroniza a frota (ou uma placa) consultando o portal numa ÚNICA chamada
 * (`list-logado` aceita todas as placas). Mais robusto que N pedidos, já que a
 * sessão do BFF é curta.
 */
export async function sincronizarPedagiosFrota(opts?: {
  placa?: string;
  dryRun?: boolean;
}): Promise<SyncPedagiosResult[]> {
  const placas = loadPlacasParaSync(opts?.placa);
  if (placas.length === 0) return [];

  let porPlaca: Map<string, PassagemPedagio[]>;
  try {
    porPlaca = agruparPorPlaca(await listarPassagensLote(placas, { status: "aberto" }), placas);
  } catch (e) {
    // Sessão inválida/expirada: aborta cedo com mensagem clara (recapturar
    // PEDAGIO_DIGITAL_COOKIE + PEDAGIO_DIGITAL_CSRF) em vez de devolver o mesmo
    // aviso repetido por placa, fingindo que processou a frota.
    if (e instanceof PedagioAuthError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    return placas.map((placa) => ({
      placa: formatPlacaHyphen(placa),
      novos: 0,
      atualizados: 0,
      semAlteracao: 0,
      ignorados: 0,
      avisos: [msg],
    }));
  }

  return placas.map((placa) =>
    processarPassagens(placa, porPlaca.get(compactPlaca(placa)) ?? [], {
      dryRun: opts?.dryRun,
    }),
  );
}
