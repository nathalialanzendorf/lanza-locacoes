/**
 * Sincronização bidirecional: rastreáveis (Rastreame) ↔ database/veiculos.json.
 * A base local é fonte da verdade; alterações locais replicam no Rastreame.
 */
import fs from "node:fs";
import path from "node:path";

import { listarMarcas, resolverFipeVeiculo } from "../fipe/index.js";
import { compactPlaca, formatPlacaHyphen, placasIguais } from "../placa.js";
import { REPO_ROOT } from "../repoRoot.js";
import {
  aplicarFipeVeiculo,
  editarVeiculo,
  isSyncRastreameEligible,
  isVeiculoAtivo,
  loadVeiculosDb,
  marcarVeiculoRastreameSyncOk,
  precisaFipe,
  type UpsertRastreavelInput,
  type VeiculoRegistro,
  upsertVeiculoFromRastreame,
} from "../veiculosDb.js";
import { extrairPlacaDeRastreavel, rastreavelTexto, refKey } from "./placaRastreavel.js";
import {
  fetchAllRastreaveis,
  fetchRastreavelByKey,
  putRastreavel,
  type Rastreavel,
} from "./rastreavel.js";

export type SyncRastreaveisOpts = {
  dryRun?: boolean;
  pull?: boolean;
  push?: boolean;
  forcePull?: boolean;
  /** Resolver FIPE dos veículos novos/sem FIPE após o pull (default: true). */
  fipe?: boolean;
};

export type SyncRastreaveisResult = {
  pull: { novos: number; atualizados: number; inativados: number; ignorados: number; erros: string[] };
  push: { criados: number; atualizados: number; inativados: number; ignorados: number; erros: string[] };
  fipe: { atualizados: number; ignorados: number; erros: string[] };
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
  const value = rastreavelTexto(r);
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

/** Extrai texto de um campo que pode ser string ou referência `{ value }`. */
function valorRef(x: unknown): string | undefined {
  if (x == null) return undefined;
  if (typeof x === "object") {
    const v = (x as { value?: unknown }).value;
    return v != null && String(v).trim() ? String(v).trim() : undefined;
  }
  const s = String(x).trim();
  return s || undefined;
}

function numeroOpt(x: unknown): number | undefined {
  if (x == null || x === "") return undefined;
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Mapeia o **detalhe** do rastreável (GET /rastreavel/{id}) para os campos do
 * CRV-e em veiculos.json. O detalhe traz marca/modelo/ano/chassi/renavam/cor,
 * que não existem na listagem.
 */
function rastreavelDetalheToInput(d: Rastreavel): UpsertRastreavelInput | null {
  const key = refKey(d);
  if (!key) return null;
  const ident = String(d.identificador ?? "").trim();
  const placa = extrairPlacaDeRastreavel(ident) ?? (ident ? formatPlacaHyphen(ident) : null);
  if (!placa) return null;

  const descricao = String(d.descricao ?? "").trim();
  const marca = valorRef(d.marca);
  const modelo = valorRef(d.modelo);
  const ano = numeroOpt(d.ano);
  const marcaModelo = [marca, modelo].filter(Boolean).join("/") || undefined;
  const anoModelo = ano ? `${ano}/${ano}` : undefined;
  const label = descricao ? `${placa} - ${descricao}` : placa;

  return {
    rastreameRastreavelKey: key,
    placa,
    marcaModelo,
    anoModelo,
    rastreameLabel: label,
    ativo: d.ativo !== false,
    chassi: valorRef(d.chassis),
    renavam: valorRef(d.renavam),
    cor: valorRef(d.cor),
    marca,
    modelo,
    ano,
    combustivel: valorRef(d.combustivel),
    categoria: valorRef(d.categoria),
    tipo: valorRef(d.tipo),
    licencaIma: valorRef(d.licencaIma),
    vencimentoDocumento: valorRef(d.vencimentoDocumento),
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

    // O detalhe (GET /rastreavel/{id}) traz os campos do CRV-e; a listagem não.
    let input: UpsertRastreavelInput | null = null;
    try {
      const detalhe = await fetchRastreavelByKey(key);
      input = rastreavelDetalheToInput(detalhe);
    } catch (e) {
      result.erros.push(
        `rastreável ${key}: falha ao obter detalhe (${e instanceof Error ? e.message : String(e)}) — usando listagem`,
      );
    }
    if (!input) input = rastreavelToUpsertInput(r);
    if (!input) {
      result.erros.push(`rastreável ${key}: placa não identificada em "${rastreavelTexto(r)}"`);
      continue;
    }

    if (opts.dryRun) {
      console.log(
        `[pull dry-run] key=${key} | ${input.placa} | ativo=${input.ativo} | ${input.marca ?? "?"}/${input.modelo ?? "?"} ${input.ano ?? ""} | chassi=${input.chassi ?? "-"} renavam=${input.renavam ?? "-"} cor=${input.cor ?? "-"}`,
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

type PushAcao =
  | "criado"
  | "atualizado"
  | "inativado"
  | "ignorado"
  | "novo_remoto_ausente"
  | "erro";

async function pushOneVeiculo(
  v: VeiculoRegistro,
  ctx: { parceiros: Map<string, string>; rastreaveis: Rastreavel[]; dryRun: boolean },
): Promise<PushAcao> {
  const parceiro = parceirosNome(ctx.parceiros, v.id);
  const label = buildRastreavelLabel(v, parceiro);

  // Nunca enviamos inativação ao Rastreame: veículo inativo no database local
  // não recebe push (ver regra "Inativação só local" em .cursor/rules/lanza-tools.mdc).
  if (v.ativo === false) return "ignorado";

  if (!v.rastreameRastreavelKey) {
    const existente = ctx.rastreaveis.find((r) => {
      const p = extrairPlacaDeRastreavel(rastreavelTexto(r));
      return p != null && placasIguais(p, v.placa);
    });
    if (existente) {
      const key = refKey(existente);
      if (key) {
        if (ctx.dryRun) {
          console.log(`[push dry-run] link ${v.placa} → key=${key} (já no Rastreame)`);
          return "criado";
        }
        marcarVeiculoRastreameSyncOk(v.id, key, label);
        return "criado";
      }
    }
    // Não existe no Rastreame: criar um rastreável exige associação de dispositivo
    // e dados completos (chassi, renavam, etc.) — fazer manualmente na UI.
    console.log(
      `[push] ${v.placa} não existe no Rastreame — cadastrar manualmente (rastreável precisa de dispositivo). Ignorado.`,
    );
    return "novo_remoto_ausente";
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
  const rastreaveis = await fetchAllRastreaveis();
  // Só veículos ativos entram no push; inativos nunca são enviados ao Rastreame.
  const candidatos = db.veiculos.filter((v) => v.ativo !== false && isSyncRastreameEligible(v));

  for (const v of candidatos) {
    try {
      const acao = await pushOneVeiculo(v, {
        parceiros,
        rastreaveis,
        dryRun: opts.dryRun ?? false,
      });
      if (acao === "criado") result.criados++;
      else if (acao === "atualizado") result.atualizados++;
      else if (acao === "ignorado") result.ignorados++;
      else if (acao === "novo_remoto_ausente") {
        result.ignorados++;
        result.erros.push(`${v.placa}: não existe no Rastreame — cadastrar manualmente (precisa de dispositivo)`);
      }
    } catch (e) {
      result.erros.push(`${v.placa}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}

/**
 * Resolve FIPE (tool `src/lib/fipe`) para veículos sem dados FIPE — tipicamente
 * os recém-importados do Rastreame. Idempotente: uma vez preenchido, é ignorado.
 */
export async function preencherFipeFaltante(
  opts: SyncRastreaveisOpts = {},
): Promise<SyncRastreaveisResult["fipe"]> {
  const result = { atualizados: 0, ignorados: 0, erros: [] as string[] };
  const db = loadVeiculosDb();
  // Veículos inativos não recebem consultas externas (FIPE) — ver regra em
  // .cursor/rules/lanza-tools.mdc ("Veículos inativos").
  const pendentes = db.veiculos.filter((v) => isVeiculoAtivo(v) && precisaFipe(v));
  if (pendentes.length === 0) return result;

  if (opts.dryRun) {
    for (const v of pendentes) {
      console.log(`[fipe dry-run] resolveria ${v.placa} (${v.marca ?? v.marcaModelo ?? "?"})`);
    }
    result.atualizados = pendentes.length;
    return result;
  }

  let brands: Awaited<ReturnType<typeof listarMarcas>>;
  try {
    brands = await listarMarcas();
  } catch (e) {
    result.erros.push(`FIPE indisponível: ${e instanceof Error ? e.message : String(e)}`);
    return result;
  }

  for (const v of pendentes) {
    try {
      const r = await resolverFipeVeiculo(v, brands);
      aplicarFipeVeiculo(v.id, {
        fipe: r.fipe,
        fipeCodigo: r.fipeCodigo,
        fipeModelo: r.fipeModelo,
        fipeValor: r.fipeValor,
        fipeReferencia: r.fipeReferencia,
      });
      result.atualizados++;
    } catch (e) {
      result.ignorados++;
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
  const fipe = opts.fipe !== false;
  const out: SyncRastreaveisResult = {
    pull: { novos: 0, atualizados: 0, inativados: 0, ignorados: 0, erros: [] },
    push: { criados: 0, atualizados: 0, inativados: 0, ignorados: 0, erros: [] },
    fipe: { atualizados: 0, ignorados: 0, erros: [] },
  };

  if (push) out.push = await pushRastreaveisToRastreame(opts);
  if (pull) out.pull = await pullRastreaveisFromRastreame(opts);
  // FIPE só faz sentido depois do pull (precisa dos veículos importados).
  if (fipe && pull) out.fipe = await preencherFipeFaltante(opts);
  return out;
}

export async function replicarVeiculoNoRastreame(
  v: VeiculoRegistro,
  opts?: { dryRun?: boolean },
): Promise<void> {
  if (!isSyncRastreameEligible(v) && v.ativo !== false) return;
  const parceiros = loadParceiroPorVeiculo();
  const rastreaveis = await fetchAllRastreaveis();
  const acao = await pushOneVeiculo(v, { parceiros, rastreaveis, dryRun: opts?.dryRun ?? false });
  if (acao === "erro") {
    throw new Error(`Falha ao replicar ${v.placa} no Rastreame`);
  }
}
