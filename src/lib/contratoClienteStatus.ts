/**
 * (Des)ativação do cliente ligada ao ciclo de vida do contrato.
 *
 * Regra de negócio (cadastro-contrato):
 * - Ao **gerar** um contrato: se o cliente existe e está inativo, é **reativado**
 *   no database local E no Rastreame.
 * - Ao **encerrar** um contrato: o cliente é **inativado** no database local E no
 *   Rastreame — desde que não tenha **outro contrato ativo** (ex.: 2 veículos).
 *
 * Esta é a exceção autorizada à regra "Inativação só local" (ver
 * .cursor/rules/lanza-tools.mdc): a inativação por encerramento de contrato
 * É empurrada ao Rastreame.
 *
 * O lado Rastreame é best-effort: falha de rede/token apenas gera aviso; a
 * alteração local (fonte da verdade) é sempre aplicada.
 */
import {
  editarCliente,
  findClienteById,
  findClienteByCpf,
  normNomeKey,
  type ClienteRegistro,
} from "./clientesDb.js";
import { loadContratosDb } from "./contratosDb.js";
import { normCpfKey } from "./rastreame/mapMotoristaCliente.js";
import { inativarMotorista } from "./rastreame/motorista.js";
import { replicarClienteNoRastreame } from "./rastreame/motoristasSync.js";

export type ClienteContratoRef = {
  clienteId?: string | null;
  cpf?: string | null;
  nome?: string | null;
};

export type StatusClienteResult = {
  cliente: ClienteRegistro | null;
  /** Ação aplicada no database local. */
  local: "ativado" | "inativado" | "sem_alteracao" | "nao_encontrado";
  /** Ação no Rastreame. */
  rastreame: "ativado" | "inativado" | "ignorado" | "erro";
  aviso?: string;
};

function resolverCliente(ref: ClienteContratoRef): ClienteRegistro | null {
  if (ref.clienteId) {
    const c = findClienteById(ref.clienteId);
    if (c) return c;
  }
  if (ref.cpf) {
    const c = findClienteByCpf(ref.cpf);
    if (c) return c;
  }
  return null;
}

function mesmoCliente(
  contratoClienteId: string | null,
  contratoCpf: string | null,
  contratoNome: string,
  cliente: ClienteRegistro,
): boolean {
  if (contratoClienteId && cliente.id && contratoClienteId === cliente.id) return true;
  if (contratoCpf && cliente.cpf && normCpfKey(contratoCpf) === normCpfKey(String(cliente.cpf))) {
    return true;
  }
  return Boolean(contratoNome && normNomeKey(contratoNome) === normNomeKey(cliente.nome));
}

/** true se o cliente tem outro contrato ativo além de `excetoContratoId`. */
export function temOutroContratoAtivo(
  cliente: ClienteRegistro,
  excetoContratoId?: string | null,
): boolean {
  const db = loadContratosDb();
  return db.contratos.some(
    (c) =>
      c.status === "ativo" &&
      c.id !== excetoContratoId &&
      mesmoCliente(c.clienteId, c.cpf, c.clienteNome, cliente),
  );
}

/**
 * Reativa o cliente (local + Rastreame) ao gerar/renovar contrato.
 * Só age quando o cliente está inativo; cliente já ativo é no-op.
 */
export async function ativarClienteDoContrato(
  ref: ClienteContratoRef,
  opts: { dryRun?: boolean } = {},
): Promise<StatusClienteResult> {
  const cliente = resolverCliente(ref);
  if (!cliente) {
    return { cliente: null, local: "nao_encontrado", rastreame: "ignorado" };
  }
  if (cliente.ativo !== false) {
    return { cliente, local: "sem_alteracao", rastreame: "ignorado" };
  }
  if (opts.dryRun) {
    return { cliente, local: "ativado", rastreame: "ativado" };
  }

  const atualizado = editarCliente(cliente.id, { ativo: true }) ?? cliente;
  let rastreame: StatusClienteResult["rastreame"] = "ignorado";
  let aviso: string | undefined;
  try {
    await replicarClienteNoRastreame({ ...atualizado, ativo: true });
    rastreame = "ativado";
  } catch (e) {
    rastreame = "erro";
    aviso = `Rastreame não atualizado (${e instanceof Error ? e.message : String(e)})`;
  }
  return { cliente: atualizado, local: "ativado", rastreame, aviso };
}

/**
 * Inativa o cliente (local + Rastreame) ao encerrar contrato — exceto se ainda
 * houver outro contrato ativo para o mesmo cliente.
 */
export async function desativarClienteDoContrato(
  ref: ClienteContratoRef & { contratoId?: string | null },
  opts: { dryRun?: boolean } = {},
): Promise<StatusClienteResult> {
  const cliente = resolverCliente(ref);
  if (!cliente) {
    return { cliente: null, local: "nao_encontrado", rastreame: "ignorado" };
  }
  if (temOutroContratoAtivo(cliente, ref.contratoId)) {
    return {
      cliente,
      local: "sem_alteracao",
      rastreame: "ignorado",
      aviso: "cliente tem outro contrato ativo — mantido ativo",
    };
  }
  if (cliente.ativo === false) {
    return { cliente, local: "sem_alteracao", rastreame: "ignorado" };
  }
  if (opts.dryRun) {
    return { cliente, local: "inativado", rastreame: "inativado" };
  }

  const atualizado = editarCliente(cliente.id, { ativo: false }) ?? cliente;
  let rastreame: StatusClienteResult["rastreame"] = "ignorado";
  let aviso: string | undefined;
  const key = atualizado.rastreameMotoristaKey;
  if (key != null && key !== "") {
    try {
      await inativarMotorista(key);
      rastreame = "inativado";
    } catch (e) {
      rastreame = "erro";
      aviso = `Rastreame não atualizado (${e instanceof Error ? e.message : String(e)})`;
    }
  } else {
    aviso = "cliente sem vínculo Rastreame (rastreameMotoristaKey)";
  }
  return { cliente: atualizado, local: "inativado", rastreame, aviso };
}
