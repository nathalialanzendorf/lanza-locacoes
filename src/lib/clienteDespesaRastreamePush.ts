/**
 * Push automático de registos locais → Gastos Gerais (Rastreame).
 * Chamado após gravar/editar em cliente-despesas (cadastro manual e syncs).
 */
import {
  findClienteDespesaById,
  findClienteDespesaByIdAsync,
  isSyncRastreameEligible,
  type ClienteDespesaRegistro,
} from "./clienteDespesasDb.js";
import { resolveSyncRastreame } from "./rastreameEspelhoConfig.js";

export type ClienteDespesaPushOpts = {
  /** Default true — replica no Rastreame após persistir localmente. */
  syncRastreame?: boolean;
};

/** Recarrega o registo após push (rastreameId / rastreameSyncEm atualizados). */
export async function recarregarClienteDespesaAsync(
  reg: ClienteDespesaRegistro,
): Promise<ClienteDespesaRegistro> {
  return (await findClienteDespesaByIdAsync(reg.id)) ?? reg;
}

/** @deprecated use recarregarClienteDespesaAsync no Postgres */
export function recarregarClienteDespesa(
  reg: ClienteDespesaRegistro,
): ClienteDespesaRegistro {
  return findClienteDespesaById(reg.id) ?? reg;
}

export async function pushClienteDespesaRegistrosNoRastreame(
  regs: ClienteDespesaRegistro[],
  opts?: ClienteDespesaPushOpts,
): Promise<ClienteDespesaRegistro[]> {
  if (!resolveSyncRastreame(opts?.syncRastreame)) {
    return Promise.all(regs.map(recarregarClienteDespesaAsync));
  }

  const { replicarClienteDespesaNoRastreame } = await import("./rastreame/recebimentosSync.js");
  const out: ClienteDespesaRegistro[] = [];

  for (const reg of regs) {
    if (!isSyncRastreameEligible(reg) && reg.ativo !== false) {
      out.push(await recarregarClienteDespesaAsync(reg));
      continue;
    }
    try {
      await replicarClienteDespesaNoRastreame(reg);
    } catch (e) {
      console.error(
        `[aviso] falha sync Rastreame (${reg.autoInfracao}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    out.push(await recarregarClienteDespesaAsync(reg));
  }

  return out;
}
