/**
 * Push idempotente: parceiro-despesas.json → tela "Manutenção" do Rastreame.
 *
 * As despesas de parceiro/dono (Seguro, Rastreador, IPVA, Licenciamento,
 * Manutenção, etc.) são espelhadas como Manutenção no Rastreame. A base local
 * é a fonte da verdade.
 *
 * Idempotência:
 *   - com `rastreameManutencaoId` → PUT (ou skip se o hash não mudou);
 *   - sem id → dedupe por (rastreável + info + data) na listagem e, se não
 *     existir, POST; o id devolvido é guardado para as próximas execuções.
 */
import fs from "node:fs";
import crypto from "node:crypto";

import { compactPlaca } from "../placa.js";
import {
  loadParceiroDespesasDb,
  marcarBaixaParceiroDespesa,
  marcarParceiroDespesaRastreameSync,
  DB_VEICULOS,
  type ParceiroDespesaRegistro,
} from "../parceiroDespesasDb.js";
import {
  fetchAllManutencoes,
  fetchManutencaoById,
  manutencaoPaga,
  montarCorpoManutencao,
  postManutencao,
  putManutencao,
  type ManutencaoRecord,
} from "./manutencao.js";
import { refKey } from "./placaRastreavel.js";

export type SyncManutencaoOpts = {
  dryRun?: boolean;
  placa?: string;
  categoria?: string;
};

export type SyncManutencaoResult = {
  criados: number;
  atualizados: number;
  semAlteracao: number;
  ignorados: number;
  /** Despesas que receberam baixa por estarem "Pago" no Rastreame. */
  baixados: number;
  erros: string[];
};

/**
 * Reconcilia baixas: despesas locais cujo espelho de Manutenção está marcado
 * como "Pago/Quitado" no Rastreame recebem `baixa` (se ainda não tiverem).
 * Só lê; usa a listagem já buscada. Não desfaz baixas manuais.
 */
function reconciliarBaixas(
  despesas: ParceiroDespesaRegistro[],
  manutencoes: ManutencaoRecord[],
): number {
  const pagasPorId = new Map<string, boolean>();
  for (const m of manutencoes) {
    if (m.id != null) pagasPorId.set(String(m.id), manutencaoPaga(m));
  }
  let baixados = 0;
  for (const reg of despesas) {
    if (reg.baixa) continue;
    const mid = reg.rastreameManutencaoId;
    if (mid == null) continue;
    if (pagasPorId.get(String(mid)) !== true) continue;
    const r = marcarBaixaParceiroDespesa({ id: reg.id });
    if (r.atualizados.length) baixados++;
  }
  return baixados;
}

type VeiculoRastreavel = { id: string; placa: string; rastreavelKey: string | null };

function loadVeiculosRastreavel(): VeiculoRastreavel[] {
  const raw = JSON.parse(fs.readFileSync(DB_VEICULOS, "utf8")) as {
    veiculos: { id: string; placa: string; rastreameRastreavelKey?: string | number }[];
  };
  return raw.veiculos.map((v) => ({
    id: v.id,
    placa: v.placa,
    rastreavelKey: v.rastreameRastreavelKey != null ? String(v.rastreameRastreavelKey) : null,
  }));
}

/** Resolve a key do rastreável Rastreame pela placa (ou veiculoId) da despesa. */
function resolveRastreavelKey(
  reg: ParceiroDespesaRegistro,
  veiculos: VeiculoRastreavel[],
): string | null {
  if (reg.veiculoId) {
    const byId = veiculos.find((v) => v.id === reg.veiculoId);
    if (byId?.rastreavelKey) return byId.rastreavelKey;
  }
  const key = compactPlaca(reg.placa);
  const byPlaca = veiculos.find((v) => compactPlaca(v.placa) === key);
  return byPlaca?.rastreavelKey ?? null;
}

/** Converte a data da despesa (DD/MM/AAAA ou MM/AAAA) para YYYY-MM-DD. */
function dataParaIsoDate(data: string, competencia: string): string {
  const full = data.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (full) return `${full[3]}-${full[2]}-${full[1]}`;
  const comp = (competencia || data).trim().match(/^(\d{2})\/(\d{4})/);
  if (comp) return `${comp[2]}-${comp[1]}-01`;
  return new Date().toISOString().slice(0, 10);
}

function infoManutencao(reg: ParceiroDespesaRegistro): string {
  const desc = String(reg.descricao ?? "").trim();
  return desc || String(reg.categoria ?? "Manutenção").trim();
}

function hashManutencao(rastreavelKey: string, info: string, valor: number, data: string): string {
  return crypto
    .createHash("sha1")
    .update(`${rastreavelKey}|${info}|${valor}|${data}`)
    .digest("hex")
    .slice(0, 16);
}

function manutencaoDuplicada(
  manutencoes: ManutencaoRecord[],
  rastreavelKey: string,
  info: string,
  dataIso: string,
): ManutencaoRecord | null {
  const inf = info.trim();
  for (const m of manutencoes) {
    if (m.ativo === false) continue;
    const rk = refKey(m.rastreavel as { key?: string; id?: string | number });
    const md = String(m.data ?? "").slice(0, 10);
    if (rk === rastreavelKey && String(m.info ?? "").trim() === inf && md === dataIso) {
      return m;
    }
  }
  return null;
}

type Contador = "criados" | "atualizados" | "semAlteracao" | "ignorados";

async function pushOne(
  reg: ParceiroDespesaRegistro,
  ctx: { veiculos: VeiculoRastreavel[]; manutencoes: ManutencaoRecord[]; dryRun: boolean },
): Promise<{ acao: Contador; msg?: string }> {
  const rastreavelKey = resolveRastreavelKey(reg, ctx.veiculos);
  if (!rastreavelKey) {
    return { acao: "ignorados", msg: `${reg.placa}: rastreável não resolvido (sem rastreameRastreavelKey)` };
  }

  const info = infoManutencao(reg);
  const valor = Math.round(Number(reg.valor) * 100) / 100;
  const dataIso = dataParaIsoDate(reg.data, reg.competencia);
  const hash = hashManutencao(rastreavelKey, info, valor, dataIso);

  if (reg.rastreameManutencaoId) {
    if (reg.rastreameHash === hash) return { acao: "semAlteracao" };
    if (ctx.dryRun) {
      console.log(`[dry-run] PUT manutencao ${reg.rastreameManutencaoId} | ${reg.placa} | ${info} | R$ ${valor}`);
      return { acao: "atualizados" };
    }
    const atual = await fetchManutencaoById(reg.rastreameManutencaoId);
    const body = { ...atual, ...montarCorpoManutencao({ rastreavelKey, info, valor, data: dataIso }) };
    const r = await putManutencao(reg.rastreameManutencaoId, body);
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`PUT ${reg.rastreameManutencaoId} HTTP ${r.status}: ${t.slice(0, 200)}`);
    }
    marcarParceiroDespesaRastreameSync(reg.id, { hash });
    return { acao: "atualizados" };
  }

  const dup = manutencaoDuplicada(ctx.manutencoes, rastreavelKey, info, dataIso);
  if (dup?.id != null) {
    if (ctx.dryRun) {
      console.log(`[dry-run] link ${reg.placa} → manutencao ${dup.id} (já no Rastreame)`);
      return { acao: "criados" };
    }
    marcarParceiroDespesaRastreameSync(reg.id, { manutencaoId: dup.id, hash });
    return { acao: "criados" };
  }

  if (ctx.dryRun) {
    console.log(`[dry-run] POST manutencao | ${reg.placa} | ${info} | R$ ${valor} | ${dataIso} | rastreavel=${rastreavelKey}`);
    return { acao: "criados" };
  }

  const body = montarCorpoManutencao({ rastreavelKey, info, valor, data: dataIso });
  const r = await postManutencao(body);
  const text = await r.text();
  if (!r.ok) throw new Error(`POST HTTP ${r.status}: ${text.slice(0, 200)}`);
  let created: ManutencaoRecord;
  try {
    created = JSON.parse(text) as ManutencaoRecord;
  } catch {
    throw new Error(`POST resposta inválida: ${text.slice(0, 200)}`);
  }
  if (created.id == null) throw new Error("POST sem id na resposta");
  marcarParceiroDespesaRastreameSync(reg.id, { manutencaoId: created.id, hash });
  return { acao: "criados" };
}

export async function pushManutencoesToRastreame(
  opts: SyncManutencaoOpts = {},
): Promise<SyncManutencaoResult> {
  const result: SyncManutencaoResult = {
    criados: 0,
    atualizados: 0,
    semAlteracao: 0,
    ignorados: 0,
    baixados: 0,
    erros: [],
  };

  const db = loadParceiroDespesasDb();
  const veiculos = loadVeiculosRastreavel();

  let manutencoes: ManutencaoRecord[] = [];
  try {
    manutencoes = await fetchAllManutencoes(100);
  } catch (e) {
    console.warn(
      `[manutencao] listagem indisponível (${e instanceof Error ? e.message : String(e)}); dedupe via rastreameManutencaoId local.`,
    );
  }

  const placaKey = opts.placa ? compactPlaca(opts.placa) : null;
  const catKey = opts.categoria ? opts.categoria.trim().toLowerCase() : null;

  const candidatos = db.parceiroDespesas.filter((d) => {
    if (placaKey && compactPlaca(d.placa) !== placaKey) return false;
    if (catKey && String(d.categoria).trim().toLowerCase() !== catKey) return false;
    return true;
  });

  for (const reg of candidatos) {
    try {
      const { acao, msg } = await pushOne(reg, {
        veiculos,
        manutencoes,
        dryRun: opts.dryRun ?? false,
      });
      result[acao]++;
      if (acao === "ignorados" && msg) result.erros.push(msg);
    } catch (e) {
      result.erros.push(`${reg.placa} (${reg.categoria}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Baixa por status "Pago/Quitado" no Rastreame (recarrega para pegar os ids
  // recém-vinculados acima). Só aplica quando há listagem e não é dry-run.
  if (!opts.dryRun && manutencoes.length) {
    const fresh = loadParceiroDespesasDb().parceiroDespesas.filter((d) => {
      if (placaKey && compactPlaca(d.placa) !== placaKey) return false;
      if (catKey && String(d.categoria).trim().toLowerCase() !== catKey) return false;
      return true;
    });
    result.baixados = reconciliarBaixas(fresh, manutencoes);
  }

  return result;
}
