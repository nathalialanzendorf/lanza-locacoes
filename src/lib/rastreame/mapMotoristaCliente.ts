/**
 * Converte motorista Rastreame → registro de database/clientes.json.
 *
 * REGRA: o campo `observacao` do Rastreame NÃO é usado (nem lido nem escrito).
 * Só são importados os campos NATIVOS do motorista:
 *   - nome, cpf, cnh (número), categoriaCnh.key, vencimentoCnh (ISO),
 *     contato.{celular,fixo,email}
 *
 * Os demais campos que o Rastreame não tem (endereço, RG, filiação, nascimento,
 * espelho/órgão emissor, 1ª habilitação) ficam APENAS na database cliente e são
 * preservados no merge (não-destrutivo) — ver `upsertClienteFromRastreame`.
 */
import type { MotoristaRastreame } from "./motorista.js";

export type ClienteImportado = Record<string, unknown> & {
  id?: string;
  nome?: string;
  cpf?: string;
  rastreameMotoristaKey?: string;
  rastreameMotoristaId?: string | number;
};

function isoToBr(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

function formatCpf(value: string | null | undefined): string | null {
  const d = String(value ?? "").replace(/\D/g, "");
  if (d.length !== 11) return null;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

function formatTelefone(value: string | null | undefined): string | null {
  const d = String(value ?? "").replace(/\D/g, "");
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return d || null;
}

export function motoristaToCliente(m: MotoristaRastreame): ClienteImportado | null {
  const nome = (m.nome ?? "").trim();
  if (!nome) return null;

  const cpf = formatCpf(m.cpf ?? undefined);
  const cnhNum = String(m.cnh ?? "").replace(/\D/g, "");
  const categoria = m.categoriaCnh?.key ?? m.categoriaCnh?.value;
  const validade = isoToBr(m.vencimentoCnh);
  const telefone = formatTelefone(m.contato?.celular ?? m.contato?.fixo ?? null);
  const email = m.contato?.email ?? null;

  const cnh: Record<string, unknown> = {};
  if (cnhNum) cnh.numeroRegistro = cnhNum;
  if (categoria) cnh.categoria = categoria;
  if (validade) cnh.validade = validade;

  const cliente: ClienteImportado = {
    nome,
    telefone,
    email,
    rastreameMotoristaKey:
      m.key != null ? String(m.key) : m.id != null ? String(m.id) : undefined,
    rastreameMotoristaId: m.id,
    origemImportacao: "rastreame",
  };
  if (cpf) cliente.cpf = cpf;
  if (Object.keys(cnh).length) cliente.cnh = cnh;

  return cliente;
}

export function normCpfKey(cpf: string): string {
  return cpf.replace(/\D/g, "");
}
