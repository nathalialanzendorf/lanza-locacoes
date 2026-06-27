/**
 * Sincronização bidirecional: motoristas (Rastreame) ↔ database/clientes.json.
 * A base local é fonte da verdade; alterações locais replicam no Rastreame.
 */
import {
  editarCliente,
  isClienteAtivo,
  isSyncRastreameEligible,
  loadClientesDb,
  marcarClienteRastreameSyncOk,
  type ClienteRegistro,
  upsertClienteFromRastreame,
} from "../clientesDb.js";
import { motoristaToCliente } from "./mapMotoristaCliente.js";
import { refKey } from "./placaRastreavel.js";
import {
  buildMotoristaPayload,
  fetchAllMotoristasDetailed,
  fetchMotoristaByKey,
  findMotorista,
  postMotoristaPayload,
  putMotorista,
  type MotoristaRastreame,
} from "./motorista.js";

export type SyncMotoristasOpts = {
  dryRun?: boolean;
  pull?: boolean;
  push?: boolean;
  forcePull?: boolean;
};

export type SyncMotoristasResult = {
  pull: { novos: number; atualizados: number; inativados: number; ignorados: number; erros: string[] };
  push: { criados: number; atualizados: number; inativados: number; ignorados: number; erros: string[] };
};

function motoristaKey(m: MotoristaRastreame): string {
  return refKey(m);
}

export async function pullMotoristasFromRastreame(
  opts: SyncMotoristasOpts = {},
): Promise<SyncMotoristasResult["pull"]> {
  const result = { novos: 0, atualizados: 0, inativados: 0, ignorados: 0, erros: [] as string[] };
  const motoristas = await fetchAllMotoristasDetailed();
  const keysPresentes = new Set(motoristas.map(motoristaKey).filter(Boolean));

  for (const m of motoristas) {
    const key = motoristaKey(m);
    if (!key) continue;

    const cliente = motoristaToCliente(m);
    if (!cliente) {
      result.erros.push(`${m.nome ?? key}: sem CPF/CNH para importar`);
      continue;
    }

    if (opts.dryRun) {
      console.log(
        `[pull dry-run] key=${key} | ${cliente.nome} | CPF ${cliente.cpf ?? "?"} | ativo=${m.ativo !== false}`,
      );
      result.novos++;
      continue;
    }

    try {
      const r = upsertClienteFromRastreame({
        ...cliente,
        rastreameMotoristaKey: key,
        rastreameMotoristaId: m.id,
        ativo: m.ativo !== false,
        force: opts.forcePull,
      });
      if (r.acao === "novo") result.novos++;
      else if (r.acao === "atualizado") result.atualizados++;
      else result.ignorados++;
    } catch (e) {
      result.erros.push(`${m.nome ?? key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const db = loadClientesDb();
  for (const c of db.clientes) {
    if (c.rastreameMotoristaKey == null || c.rastreameMotoristaKey === "") continue;
    const rk = String(c.rastreameMotoristaKey);
    if (keysPresentes.has(rk)) continue;
    if (!isClienteAtivo(c)) {
      result.ignorados++;
      continue;
    }
    if (opts.dryRun) {
      console.log(`[pull dry-run] inativar local ${c.nome} (key ${rk} ausente no Rastreame)`);
      result.inativados++;
      continue;
    }
    editarCliente(c.id, { ativo: false });
    result.inativados++;
  }

  return result;
}

async function pushOneCliente(
  c: ClienteRegistro,
  ctx: { dryRun: boolean },
): Promise<"criado" | "atualizado" | "ignorado"> {
  // Nunca enviamos inativação ao Rastreame: se está inativo no database local,
  // não fazemos push. O pull continua atualizando o registo local a partir do
  // Rastreame (ver regra "Inativação só local" em .cursor/rules/lanza-tools.mdc).
  if (c.ativo === false) return "ignorado";

  if (!isSyncRastreameEligible(c)) return "ignorado";

  const payload = buildMotoristaPayload(c);

  if (!c.rastreameMotoristaKey) {
    const cnh = String(c.cnh?.numero ?? "");
    const existente = await findMotorista(cnh, c.nome ?? "");
    if (existente) {
      const key = motoristaKey(existente);
      if (key) {
        if (ctx.dryRun) {
          console.log(`[push dry-run] link ${c.nome} → key=${key} (já no Rastreame)`);
          return "criado";
        }
        marcarClienteRastreameSyncOk(c.id, key, existente.id);
        return "criado";
      }
    }
    if (ctx.dryRun) {
      console.log(`[push dry-run] POST ${c.nome} | CPF ${c.cpf ?? "?"}`);
      return "criado";
    }
    const created = await postMotoristaPayload(payload);
    const key = motoristaKey(created);
    if (!key) throw new Error("POST motorista sem key na resposta");
    marcarClienteRastreameSyncOk(c.id, key, created.id);
    return "criado";
  }

  const needsPush =
    !c.rastreameSyncEm ||
    (c.atualizadoEm != null && c.rastreameSyncEm != null && c.atualizadoEm > c.rastreameSyncEm);

  if (!needsPush) return "ignorado";

  if (ctx.dryRun) {
    console.log(`[push dry-run] PUT key=${c.rastreameMotoristaKey} | ${c.nome}`);
    return "atualizado";
  }

  const atual = await fetchMotoristaByKey(c.rastreameMotoristaKey);
  await putMotorista(c.rastreameMotoristaKey, {
    ...atual,
    ...payload,
    ativo: true,
  });
  marcarClienteRastreameSyncOk(c.id, c.rastreameMotoristaKey, c.rastreameMotoristaId ?? undefined);
  return "atualizado";
}

export async function pushMotoristasToRastreame(
  opts: SyncMotoristasOpts = {},
): Promise<SyncMotoristasResult["push"]> {
  const result = {
    criados: 0,
    atualizados: 0,
    inativados: 0,
    ignorados: 0,
    erros: [] as string[],
  };

  const db = loadClientesDb();
  // Só clientes ativos entram no push; inativos nunca são enviados ao Rastreame.
  const candidatos = db.clientes.filter((c) => c.ativo !== false && isSyncRastreameEligible(c));

  for (const c of candidatos) {
    try {
      const acao = await pushOneCliente(c, { dryRun: opts.dryRun ?? false });
      if (acao === "criado") result.criados++;
      else if (acao === "atualizado") result.atualizados++;
      else result.ignorados++;
    } catch (e) {
      result.erros.push(`${c.nome}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}

export async function syncMotoristas(
  opts: SyncMotoristasOpts = {},
): Promise<SyncMotoristasResult> {
  const pull = opts.pull !== false;
  const push = opts.push !== false;
  const out: SyncMotoristasResult = {
    pull: { novos: 0, atualizados: 0, inativados: 0, ignorados: 0, erros: [] },
    push: { criados: 0, atualizados: 0, inativados: 0, ignorados: 0, erros: [] },
  };

  if (push) out.push = await pushMotoristasToRastreame(opts);
  if (pull) out.pull = await pullMotoristasFromRastreame(opts);
  return out;
}

export async function replicarClienteNoRastreame(
  c: ClienteRegistro,
  opts?: { dryRun?: boolean },
): Promise<void> {
  if (!isSyncRastreameEligible(c) && c.ativo !== false) return;
  const acao = await pushOneCliente(c, { dryRun: opts?.dryRun ?? false });
  if (acao === "erro") {
    throw new Error(`Falha ao replicar ${c.nome} no Rastreame`);
  }
}
