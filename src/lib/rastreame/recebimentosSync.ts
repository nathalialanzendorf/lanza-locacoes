/**
 * Sincronização bidirecional: Gastos Gerais (Rastreame, tipo OUTROS) ↔ cliente-despesas.json.
 * A base local é fonte da verdade; alterações locais replicam no Rastreame.
 */
import fs from "node:fs";
import path from "node:path";

import {
  editarClienteDespesa,
  isSyncRastreameEligible,
  loadClienteDespesasDb,
  marcarRastreameSyncOk,
  type ClienteDespesaRegistro,
  upsertRecebimentoFromRastreame,
} from "../clienteDespesasDb.js";
import { placasIguais } from "../placa.js";
import { REPO_ROOT } from "../repoRoot.js";
import {
  fetchAllGastos,
  fetchGastoById,
  inativarGasto,
  postGasto,
  putGasto,
  type GastoRecord,
} from "./gasto.js";
import { listMotoristas, type MotoristaRastreame } from "./motorista.js";
import { extrairPlacaDeRastreavel, refKey } from "./placaRastreavel.js";
import { listRastreaveis, type Rastreavel } from "./rastreavel.js";

export type SyncRecebimentosOpts = {
  dryRun?: boolean;
  pull?: boolean;
  push?: boolean;
  forcePull?: boolean;
  motoristaKey?: string;
};

export type SyncRecebimentosResult = {
  pull: { novos: number; atualizados: number; ignorados: number; erros: string[] };
  push: { criados: number; atualizados: number; inativados: number; ignorados: number; erros: string[] };
};

type ClienteDb = {
  id?: string;
  nome?: string;
  rastreameMotoristaKey?: string;
};

type UpsertRecebimentoInput = Parameters<typeof upsertRecebimentoFromRastreame>[0];

function isoToBr(iso: string | undefined | null): string {
  if (!iso) return "";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function brToIsoEndDay(dataBr: string): string {
  const m = dataBr.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return new Date().toISOString();
  return new Date(`${m[3]}-${m[2]}-${m[1]}T23:59:00-03:00`).toISOString();
}

function normNome(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function loadClientes(): ClienteDb[] {
  const p = path.join(REPO_ROOT, "database", "clientes.json");
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as { clientes?: ClienteDb[] };
    return j.clientes ?? [];
  } catch {
    return [];
  }
}

function isGastoOutros(g: GastoRecord): boolean {
  const tipo = (g.tipo as { key?: string } | undefined)?.key ?? "";
  return tipo.toUpperCase() === "OUTROS";
}

function isGastoAtivo(g: GastoRecord): boolean {
  return g.ativo !== false;
}

export function categoriaFromInfo(info: string): string {
  const t = info.toLowerCase();
  if (/pagamento semanal|semanal/.test(t)) return "Locação semanal";
  if (/cau[cç][aã]o/.test(t)) return "Caução";
  if (/manuten|avaria|porta|parachoque|reparo/.test(t)) return "Manutenção";
  if (/lava/.test(t)) return "Lavação";
  if (/estacion/.test(t)) return "Estacionamento";
  if (/ped[aá]gio/.test(t)) return "Pedágio";
  if (/quebra|encerramento|rescis/.test(t)) return "Quebra contrato";
  return "Outros";
}

export function isGastoEmAberto(info: string): boolean {
  const t = String(info ?? "").trim();
  if (t.startsWith("[NEGOCIADO")) return false;
  return /ATRASADO/i.test(t);
}

function situacaoFromGasto(info: string, emAberto: boolean): string {
  if (emAberto) return "Em aberto";
  if (/pago|quitad|recebido/i.test(info)) return "Pago";
  return "Registrado";
}

function resolveCondutorId(
  motoristaKey: string,
  motoristaNome: string,
  clientes: ClienteDb[],
  motoristas: MotoristaRastreame[],
): string | null {
  for (const c of clientes) {
    if (c.rastreameMotoristaKey && String(c.rastreameMotoristaKey) === motoristaKey && c.id) {
      return c.id;
    }
  }
  const alvo = normNome(motoristaNome);
  for (const c of clientes) {
    const n = normNome(c.nome ?? "");
    if (!n || !c.id) continue;
    if (n === alvo || n.includes(alvo) || alvo.includes(n)) return c.id;
  }
  for (const m of motoristas) {
    if (refKey(m) !== motoristaKey) continue;
    const n = normNome(m.nome ?? "");
    for (const c of clientes) {
      const cn = normNome(c.nome ?? "");
      if (cn && (cn === n || cn.includes(n) || n.includes(cn)) && c.id) return c.id;
    }
  }
  return null;
}

function resolveRastreavelKey(placa: string, rastreaveis: Rastreavel[]): string | null {
  for (const r of rastreaveis) {
    const p = extrairPlacaDeRastreavel(String(r.value ?? ""));
    if (p && placasIguais(p, placa)) return refKey(r);
  }
  return null;
}

function resolveMotoristaKey(
  reg: ClienteDespesaRegistro,
  clientes: ClienteDb[],
  motoristas: MotoristaRastreame[],
): string | null {
  if (reg.rastreameMotoristaKey) return String(reg.rastreameMotoristaKey);
  if (reg.condutorId) {
    const c = clientes.find((x) => x.id === reg.condutorId);
    if (c?.rastreameMotoristaKey) return String(c.rastreameMotoristaKey);
    const nome = c?.nome ?? "";
    if (nome) {
      const alvo = normNome(nome);
      for (const m of motoristas) {
        const n = normNome(m.nome ?? "");
        if (n && (n === alvo || n.includes(alvo) || alvo.includes(n))) return refKey(m);
      }
    }
  }
  return null;
}

function infoParaRastreame(reg: ClienteDespesaRegistro): string {
  let info = String(reg.descricao ?? "").trim();
  const emAberto =
    reg.paga !== true && (reg.situacao === "Em aberto" || isGastoEmAberto(info));
  if (emAberto && !/ATRASADO/i.test(info)) {
    info = `ATRASADO - ${info}`;
  }
  if (!emAberto && reg.paga === true) {
    info = info.replace(/^ATRASADO\s*[-–—]?\s*/i, "").trim();
  }
  return info;
}

function gastoToUpsertInput(
  g: GastoRecord,
  ctx: { clientes: ClienteDb[]; motoristas: MotoristaRastreame[] },
): UpsertRecebimentoInput | null {
  const id = g.id;
  if (id == null) return null;

  const motoristaKey = refKey(g.motorista);
  const rastreavelKey = refKey(g.rastreavel);
  const rastreavelValue = String((g.rastreavel as { value?: string } | undefined)?.value ?? "");
  const placa = extrairPlacaDeRastreavel(rastreavelValue);
  if (!placa) return null;

  const info = String(g.info ?? "").trim();
  const emAberto = isGastoEmAberto(info);
  const motoristaNome = String((g.motorista as { value?: string } | undefined)?.value ?? "");

  return {
    rastreameId: id,
    veiculoId: placa,
    categoria: categoriaFromInfo(info),
    descricao: info,
    dataAutuacao: isoToBr(g.data as string | undefined),
    valorMulta: Math.round(Number(g.total ?? 0) * 100) / 100,
    situacao: situacaoFromGasto(info, emAberto),
    paga: !emAberto,
    condutorId: resolveCondutorId(motoristaKey, motoristaNome, ctx.clientes, ctx.motoristas),
    rastreameMotoristaKey: motoristaKey || null,
    rastreameRastreavelKey: rastreavelKey || null,
    rastreameDataIso: g.data ? String(g.data) : null,
  };
}

export async function pullRecebimentosFromRastreame(
  opts: SyncRecebimentosOpts = {},
): Promise<SyncRecebimentosResult["pull"]> {
  const result = { novos: 0, atualizados: 0, ignorados: 0, erros: [] as string[] };
  const clientes = loadClientes();
  const motoristas = await listMotoristas();
  const gastos = await fetchAllGastos();
  const filtrados = gastos.filter((g) => {
    if (!isGastoOutros(g)) return false;
    if (opts.motoristaKey && refKey(g.motorista) !== opts.motoristaKey) return false;
    return true;
  });

  for (const g of filtrados) {
    const id = g.id;
    if (id == null) continue;

    if (!isGastoAtivo(g)) {
      const local = loadClienteDespesasDb().clienteDespesas.find(
        (m) => m.rastreameId != null && String(m.rastreameId) === String(id),
      );
      if (local && local.ativo !== false) {
        if (opts.dryRun) {
          console.log(`[pull dry-run] inativar local RAST-${id} (inativo no Rastreame)`);
        } else {
          editarClienteDespesa(local.id, { ativo: false });
        }
        result.atualizados++;
      } else {
        result.ignorados++;
      }
      continue;
    }

    const input = gastoToUpsertInput(g, { clientes, motoristas });
    if (!input) {
      result.erros.push(
        `gasto ${id}: placa não identificada (${String((g.rastreavel as { value?: string })?.value ?? "")})`,
      );
      continue;
    }

    if (opts.dryRun) {
      console.log(
        `[pull dry-run] RAST-${id} | ${input.veiculoId} | ${input.categoria} | R$ ${input.valorMulta} | ${input.descricao.slice(0, 60)}`,
      );
      result.novos++;
      continue;
    }

    try {
      const r = upsertRecebimentoFromRastreame({ ...input, force: opts.forcePull });
      if (r.acao === "novo") result.novos++;
      else if (r.acao === "atualizado") result.atualizados++;
      else result.ignorados++;
    } catch (e) {
      result.erros.push(`gasto ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}

async function pushOneRegistro(
  reg: ClienteDespesaRegistro,
  ctx: {
    clientes: ClienteDb[];
    motoristas: MotoristaRastreame[];
    rastreaveis: Rastreavel[];
    dryRun: boolean;
  },
): Promise<"criado" | "atualizado" | "inativado" | "ignorado" | "erro"> {
  const motoristaKey = resolveMotoristaKey(reg, ctx.clientes, ctx.motoristas);
  const rastreavelKey =
    reg.rastreameRastreavelKey ?? resolveRastreavelKey(reg.veiculoId, ctx.rastreaveis);

  if (reg.ativo === false) {
    if (!reg.rastreameId) return "ignorado";
    if (ctx.dryRun) {
      console.log(`[push dry-run] inativar Rastreame id=${reg.rastreameId} (${reg.autoInfracao})`);
      return "inativado";
    }
    try {
      await inativarGasto(reg.rastreameId);
      marcarRastreameSyncOk(reg.id);
      return "inativado";
    } catch {
      return "erro";
    }
  }

  if (!motoristaKey || !rastreavelKey) return "ignorado";

  const info = infoParaRastreame(reg);
  const dataIso =
    reg.rastreameDataIso?.trim() ||
    (reg.dataAutuacao ? brToIsoEndDay(reg.dataAutuacao) : new Date().toISOString());
  const total = reg.valorMulta;

  if (!reg.rastreameId) {
    if (ctx.dryRun) {
      console.log(
        `[push dry-run] POST ${reg.autoInfracao} | ${reg.veiculoId} | R$ ${total} | motorista=${motoristaKey} rastreavel=${rastreavelKey}`,
      );
      return "criado";
    }
    const body = {
      total,
      info,
      tipo: { key: "OUTROS" },
      rastreavel: { key: rastreavelKey },
      motorista: { key: motoristaKey },
      data: dataIso,
      ativo: true,
    };
    const r = await postGasto(body);
    const text = await r.text();
    if (!r.ok) throw new Error(`POST HTTP ${r.status}: ${text.slice(0, 300)}`);
    let created: GastoRecord;
    try {
      created = JSON.parse(text) as GastoRecord;
    } catch {
      throw new Error(`POST resposta inválida: ${text.slice(0, 200)}`);
    }
    if (created.id == null) throw new Error("POST sem id na resposta");
    marcarRastreameSyncOk(reg.id, created.id);
    return "criado";
  }

  const needsPush = !reg.rastreameSyncEm || reg.atualizadoEm > reg.rastreameSyncEm;
  if (!needsPush) return "ignorado";

  if (ctx.dryRun) {
    console.log(
      `[push dry-run] PUT ${reg.rastreameId} | ${reg.autoInfracao} | R$ ${total} | ${info.slice(0, 50)}`,
    );
    return "atualizado";
  }

  const atual = await fetchGastoById(reg.rastreameId);
  const body = {
    ...atual,
    total,
    info,
    data: dataIso,
    ativo: true,
    motorista: { ...(atual.motorista as object), key: motoristaKey },
    rastreavel: { ...(atual.rastreavel as object), key: rastreavelKey },
  };
  const r = await putGasto(reg.rastreameId, body);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`PUT ${reg.rastreameId} HTTP ${r.status}: ${t.slice(0, 300)}`);
  }
  marcarRastreameSyncOk(reg.id);
  return "atualizado";
}

export async function pushRecebimentosToRastreame(
  opts: SyncRecebimentosOpts = {},
): Promise<SyncRecebimentosResult["push"]> {
  const result = {
    criados: 0,
    atualizados: 0,
    inativados: 0,
    ignorados: 0,
    erros: [] as string[],
  };

  const db = loadClienteDespesasDb();
  const clientes = loadClientes();
  const motoristas = await listMotoristas();
  const rastreaveis = await listRastreaveis();

  const candidatos = db.clienteDespesas.filter((m) => {
    if (!isSyncRastreameEligible(m)) return false;
    if (opts.motoristaKey) {
      const mk = m.rastreameMotoristaKey ?? resolveMotoristaKey(m, clientes, motoristas);
      if (mk !== opts.motoristaKey) return false;
    }
    return true;
  });

  for (const reg of candidatos) {
    try {
      const acao = await pushOneRegistro(reg, {
        clientes,
        motoristas,
        rastreaveis,
        dryRun: opts.dryRun ?? false,
      });
      if (acao === "criado") result.criados++;
      else if (acao === "atualizado") result.atualizados++;
      else if (acao === "inativado") result.inativados++;
      else if (acao === "ignorado") result.ignorados++;
      else if (acao === "erro") {
        result.erros.push(`${reg.autoInfracao}: falha ao inativar no Rastreame`);
      }
    } catch (e) {
      result.erros.push(`${reg.autoInfracao}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}

export async function syncRecebimentos(
  opts: SyncRecebimentosOpts = {},
): Promise<SyncRecebimentosResult> {
  const pull = opts.pull !== false;
  const push = opts.push !== false;
  const out: SyncRecebimentosResult = {
    pull: { novos: 0, atualizados: 0, ignorados: 0, erros: [] },
    push: { criados: 0, atualizados: 0, inativados: 0, ignorados: 0, erros: [] },
  };

  if (push) out.push = await pushRecebimentosToRastreame(opts);
  if (pull) out.pull = await pullRecebimentosFromRastreame(opts);
  return out;
}

/** Replica um registro local no Rastreame (cadastro/edição/exclusão). */
export async function replicarClienteDespesaNoRastreame(
  reg: ClienteDespesaRegistro,
  opts?: { dryRun?: boolean },
): Promise<void> {
  if (!isSyncRastreameEligible(reg) && reg.ativo !== false) return;
  const clientes = loadClientes();
  const motoristas = await listMotoristas();
  const rastreaveis = await listRastreaveis();
  const acao = await pushOneRegistro(reg, {
    clientes,
    motoristas,
    rastreaveis,
    dryRun: opts?.dryRun ?? false,
  });
  if (acao === "erro") {
    throw new Error(`Falha ao replicar ${reg.autoInfracao} no Rastreame`);
  }
}
