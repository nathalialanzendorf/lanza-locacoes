/**
 * Sincronização bidirecional: rastreáveis (Rastreame) ↔ database/veiculos.json.
 * A base local é fonte da verdade; alterações locais replicam no Rastreame.
 */
import fs from "node:fs";
import path from "node:path";

import { compactPlaca, formatPlacaHyphen } from "../placa.js";
import { REPO_ROOT } from "../repoRoot.js";
import {
  editarVeiculo,
  isSyncRastreameEligible,
  isVeiculoAtivo,
  loadVeiculosDb,
  marcarVeiculoRastreameSyncOk,
  type VeiculoRegistro,
  upsertVeiculoFromRastreame,
} from "../veiculosDb.js";
import { extrairPlacaDeRastreavel, refKey } from "./placaRastreavel.js";
import {
  fetchAllRastreaveis,
  fetchRastreavelByKey,
  inativarRastreavel,
  postRastreavel,
  putRastreavel,
  type Rastreavel,
} from "./rastreavel.js";

export type SyncRastreaveisOpts = {
  dryRun?: boolean;
  pull?: boolean;
  push?: boolean;
  forcePull?: boolean;
};

export type SyncRastreaveisResult = {
  pull: { novos: number; atualizados: number; inativados: number; ignorados: number; erros: string[] };
  push: { criados: number; atualizados: number; inativados: number; ignorados: number; erros: string[] };
};

type Parceiro = { id: string; nome: string };
type Vinculo = { veiculoId: string; parceiroId: string };

export function parseRastreavelValue(value: string): {
  placa: string;
  marcaModelo?: string;
  anoModelo?: string;
} | null {
  const placa = extrairPlacaDeRastreavel(value);
  if (!placa) return null;

  const parts = String(value).split(/\s*-\s*/).map((p) => p.trim()).filter(Boolean);
  let marcaModelo = parts.length >= 3 ? parts.slice(2).join(" - ") : parts[1] ?? "";
  marcaModelo = marcaModelo.replace(/\([^)]*\)\s*$/, "").trim();

  const yearM = marcaModelo.match(/\b((?:19|20)\d{2})\b/);
  let anoModelo: string | undefined;
  if (yearM) {
    anoModelo = `${yearM[1]}/${yearM[1]}`;
    marcaModelo = marcaModelo.replace(/\b(?:19|20)\d{2}\b/, "").replace(/\s+/g, " ").trim();
  }

  return {
    placa,
    marcaModelo: marcaModelo || undefined,
    anoModelo,
  };
}

function loadParceiroPorVeiculo(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const parc = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "database", "parceiros.json"), "utf8"),
    ) as { parceiros?: Parceiro[] };
    const link = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "database", "parceiro-veiculo.json"), "utf8"),
    ) as { vinculos?: Vinculo[] };
    const parceiros = new Map((parc.parceiros ?? []).map((p) => [p.id, p.nome]));
    for (const v of link.vinculos ?? []) {
      const nome = parceiros.get(v.parceiroId);
      if (nome) map.set(v.veiculoId, nome);
    }
  } catch {
    /* ignore */
  }
  return map;
}

export function buildRastreavelLabel(
  v: VeiculoRegistro,
  parceiroNome?: string,
): string {
  if (v.rastreameLabel?.trim()) return v.rastreameLabel.trim();
  const placa = formatPlacaHyphen(v.placa);
  const c = compactPlaca(placa);
  const mm = [v.marcaModelo, v.anoModelo].filter(Boolean).join(" ").trim();
  const suffix = parceiroNome ? ` (${parceiroNome})` : "";
  return `${placa} - ${c}${mm ? ` - ${mm}` : ""}${suffix}`.replace(/\s+/g, " ").trim();
}

function rastreavelToUpsertInput(r: Rastreavel): Parameters<typeof upsertVeiculoFromRastreame>[0] | null {
  const key = refKey(r);
  if (!key) return null;
  const value = String(r.value ?? "").trim();
  const parsed = parseRastreavelValue(value);
  if (!parsed) return null;
  return {
    rastreameRastreavelKey: key,
    placa: parsed.placa,
    marcaModelo: parsed.marcaModelo,
    anoModelo: parsed.anoModelo,
    rastreameLabel: value,
    ativo: r.ativo !== false,
  };
}

export async function pullRastreaveisFromRastreame(
  opts: SyncRastreaveisOpts = {},
): Promise<SyncRastreaveisResult["pull"]> {
  const result = { novos: 0, atualizados: 0, inativados: 0, ignorados: 0, erros: [] as string[] };
  const rastreaveis = await fetchAllRastreaveis();
  const keysPresentes = new Set(rastreaveis.map((r) => refKey(r)).filter(Boolean));

  for (const r of rastreaveis) {
    const key = refKey(r);
    if (!key) continue;

    const input = rastreavelToUpsertInput(r);
    if (!input) {
      result.erros.push(`rastreável ${key}: placa não identificada em "${String(r.value ?? "")}"`);
      continue;
    }

    if (opts.dryRun) {
      console.log(
        `[pull dry-run] key=${key} | ${input.placa} | ativo=${input.ativo} | ${input.rastreameLabel?.slice(0, 60)}`,
      );
      result.novos++;
      continue;
    }

    try {
      const upsert = upsertVeiculoFromRastreame({ ...input, force: opts.forcePull });
      if (upsert.acao === "novo") result.novos++;
      else if (upsert.acao === "atualizado") result.atualizados++;
      else result.ignorados++;
    } catch (e) {
      result.erros.push(`rastreável ${key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const db = loadVeiculosDb();
  for (const v of db.veiculos) {
    if (v.rastreameRastreavelKey == null || v.rastreameRastreavelKey === "") continue;
    const rk = String(v.rastreameRastreavelKey);
    if (keysPresentes.has(rk)) continue;
    if (!isVeiculoAtivo(v)) {
      result.ignorados++;
      continue;
    }
    if (opts.dryRun) {
      console.log(`[pull dry-run] inativar local ${v.placa} (key ${rk} ausente no Rastreame)`);
      result.inativados++;
      continue;
    }
    editarVeiculo(v.id, { ativo: false });
    result.inativados++;
  }

  return result;
}

async function pushOneVeiculo(
  v: VeiculoRegistro,
  ctx: { parceiros: Map<string, string>; dryRun: boolean },
): Promise<"criado" | "atualizado" | "inativado" | "ignorado" | "erro"> {
  const parceiro = parceirosNome(ctx.parceiros, v.id);
  const label = buildRastreavelLabel(v, parceiro);

  if (v.ativo === false) {
    if (!v.rastreameRastreavelKey) return "ignorado";
    if (ctx.dryRun) {
      console.log(`[push dry-run] inativar Rastreame key=${v.rastreameRastreavelKey} (${v.placa})`);
      return "inativado";
    }
    try {
      await inativarRastreavel(v.rastreameRastreavelKey);
      marcarVeiculoRastreameSyncOk(v.id, v.rastreameRastreavelKey, label);
      return "inativado";
    } catch {
      return "erro";
    }
  }

  if (!v.rastreameRastreavelKey) {
    if (ctx.dryRun) {
      console.log(`[push dry-run] POST ${v.placa} | ${label.slice(0, 70)}`);
      return "criado";
    }
    const created = await postRastreavel({ value: label, ativo: true });
    const key = refKey(created);
    if (!key) throw new Error("POST rastreável sem key na resposta");
    marcarVeiculoRastreameSyncOk(v.id, key, label);
    return "criado";
  }

  const needsPush =
    !v.rastreameSyncEm ||
    (v.atualizadoEm != null && v.atualizadoEm > v.rastreameSyncEm) ||
    v.rastreameLabel !== label;

  if (!needsPush) return "ignorado";

  if (ctx.dryRun) {
    console.log(`[push dry-run] PUT key=${v.rastreameRastreavelKey} | ${v.placa} | ${label.slice(0, 60)}`);
    return "atualizado";
  }

  const atual = await fetchRastreavelByKey(v.rastreameRastreavelKey);
  await putRastreavel(v.rastreameRastreavelKey, {
    ...atual,
    value: label,
    ativo: true,
  });
  marcarVeiculoRastreameSyncOk(v.id, v.rastreameRastreavelKey, label);
  return "atualizado";
}

function parceirosNome(map: Map<string, string>, veiculoId: string): string | undefined {
  return map.get(veiculoId);
}

export async function pushRastreaveisToRastreame(
  opts: SyncRastreaveisOpts = {},
): Promise<SyncRastreaveisResult["push"]> {
  const result = {
    criados: 0,
    atualizados: 0,
    inativados: 0,
    ignorados: 0,
    erros: [] as string[],
  };

  const db = loadVeiculosDb();
  const parceiros = loadParceiroPorVeiculo();
  const candidatos = db.veiculos.filter((v) => isSyncRastreameEligible(v) || v.ativo === false);

  for (const v of candidatos) {
    if (!isSyncRastreameEligible(v) && v.ativo !== false) continue;
    try {
      const acao = await pushOneVeiculo(v, {
        parceiros,
        dryRun: opts.dryRun ?? false,
      });
      if (acao === "criado") result.criados++;
      else if (acao === "atualizado") result.atualizados++;
      else if (acao === "inativado") result.inativados++;
      else if (acao === "ignorado") result.ignorados++;
      else if (acao === "erro") {
        result.erros.push(`${v.placa}: falha ao inativar no Rastreame`);
      }
    } catch (e) {
      result.erros.push(`${v.placa}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}

export async function syncRastreaveis(
  opts: SyncRastreaveisOpts = {},
): Promise<SyncRastreaveisResult> {
  const pull = opts.pull !== false;
  const push = opts.push !== false;
  const out: SyncRastreaveisResult = {
    pull: { novos: 0, atualizados: 0, inativados: 0, ignorados: 0, erros: [] },
    push: { criados: 0, atualizados: 0, inativados: 0, ignorados: 0, erros: [] },
  };

  if (push) out.push = await pushRastreaveisToRastreame(opts);
  if (pull) out.pull = await pullRastreaveisFromRastreame(opts);
  return out;
}

export async function replicarVeiculoNoRastreame(
  v: VeiculoRegistro,
  opts?: { dryRun?: boolean },
): Promise<void> {
  if (!isSyncRastreameEligible(v) && v.ativo !== false) return;
  const parceiros = loadParceiroPorVeiculo();
  const acao = await pushOneVeiculo(v, { parceiros, dryRun: opts?.dryRun ?? false });
  if (acao === "erro") {
    throw new Error(`Falha ao replicar ${v.placa} no Rastreame`);
  }
}
