/**
 * API /keek/rest/motorista — listagem e cadastro de motorista.
 */
import fs from "node:fs";

import { RASTREAME_ORIGIN, rastreameJsonHeaders } from "./auth.js";
import { fetchRastreameWith401Retry } from "./fetchRetry.js";

const MOTORISTA_BASE = `${RASTREAME_ORIGIN}/keek/rest/motorista`;

function digits(s: string): string {
  return String(s || "").replace(/\D/g, "");
}

export type MotoristaRastreame = {
  id?: string | number;
  key?: string | number;
  nome?: string;
  cnh?: string;
  cpf?: string | null;
  observacao?: string;
  categoriaCnh?: { key?: string; value?: string } | null;
  vencimentoCnh?: string;
  contato?: { fixo?: string | null; celular?: string | null; email?: string | null } | null;
  ativo?: boolean;
};

/** @deprecated use MotoristaRastreame */
export type Motorista = MotoristaRastreame;

async function fetchMotoristaList(url: string): Promise<MotoristaRastreame[]> {
  const r = await fetchRastreameWith401Retry(url, {
    headers: await rastreameJsonHeaders(false),
  });
  const raw = await r.text();
  if (!r.ok) {
    throw new Error(`HTTP ${r.status} ao listar motoristas: ${raw.slice(0, 200)}`);
  }
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch {
    throw new Error(`Resposta inválida ao listar motoristas: ${raw.slice(0, 200)}`);
  }
  if (d && typeof d === "object" && "message" in d && !("content" in d)) {
    throw new Error(`Rastreame: ${String((d as { message?: string }).message)}`);
  }
  if (Array.isArray(d)) return d as MotoristaRastreame[];
  const page = d as { content?: MotoristaRastreame[] };
  return page.content ?? [];
}

export async function listMotoristas(): Promise<MotoristaRastreame[]> {
  const urls = [
    `${MOTORISTA_BASE}?ativo=true&size=2000`,
    `${MOTORISTA_BASE}/?ativo=true&size=2000`,
    `${MOTORISTA_BASE}`,
    `${MOTORISTA_BASE}/`,
  ];
  let lastErr: Error | null = null;
  for (const url of urls) {
    try {
      const list = await fetchMotoristaList(url);
      if (list.length > 0) return list;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (lastErr.message.includes("Autenticação")) throw lastErr;
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

export async function findMotorista(
  cnh: string,
  nome: string,
): Promise<Motorista | null> {
  const cnhD = digits(cnh);
  const nomeN = nome.trim().toLowerCase();
  for (const m of await listMotoristas()) {
    if (cnhD && digits(String(m.cnh ?? "")) === cnhD) return m;
    if (nomeN && (m.nome ?? "").trim().toLowerCase() === nomeN) return m;
  }
  return null;
}

function br2iso(d: string | undefined): string | null {
  const m = (d || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

type Cliente = Record<string, unknown>;

/** Contato nativo do Rastreame a partir dos campos da database. */
function buildContato(
  c: Cliente,
): { fixo: null; celular: string | null; email: string | null } | undefined {
  const celular = digits(c.telefone as string) || null;
  const email = (c.email as string | undefined) ?? null;
  if (!celular && !email) return undefined;
  return { fixo: null, celular, email };
}

/**
 * Payload do motorista no Rastreame — APENAS campos nativos.
 *
 * O campo `observacao` NÃO é usado: dados que o Rastreame não tem nativamente
 * (endereço, RG, filiação, nascimento, espelho/órgão emissor) ficam só na
 * database cliente. Campos nulos/ausentes são omitidos para não sobrescrever
 * valores existentes no Rastreame durante o PUT.
 */
export function buildMotoristaPayload(c: Cliente): Record<string, unknown> {
  const cnh = (c.cnh ?? {}) as Record<string, string>;
  const payload: Record<string, unknown> = {
    nome: c.nome,
    ativo: c.ativo !== false,
  };
  if (cnh.numeroRegistro) payload.cnh = digits(cnh.numeroRegistro);
  if (c.cpf) payload.cpf = digits(c.cpf as string);
  if (cnh.categoria) payload.categoriaCnh = { key: cnh.categoria };
  const venc = br2iso(cnh.validade);
  if (venc) payload.vencimentoCnh = venc;
  const contato = buildContato(c);
  if (contato) payload.contato = contato;
  return payload;
}

export async function fetchAllMotoristas(size = 100): Promise<MotoristaRastreame[]> {
  const all: MotoristaRastreame[] = [];
  const seen = new Set<string>();
  let page = 0;
  for (;;) {
    const q = new URLSearchParams({ page: String(page), size: String(size) });
    const r = await fetchRastreameWith401Retry(`${MOTORISTA_BASE}?${q.toString()}`, {
      headers: await rastreameJsonHeaders(false),
    });
    const chunk = await fetchMotoristaListFromResponse(r);
    for (const m of chunk) {
      const k = refKeyMotorista(m);
      if (k && !seen.has(k)) {
        seen.add(k);
        all.push(m);
      }
    }
    if (chunk.length < size) break;
    page++;
    if (page > 500) break;
  }
  return all;
}

/**
 * Lista todos os motoristas e busca o DETALHE de cada um.
 * A listagem (`fetchAllMotoristas`) só traz campos de resumo (id, nome, celular,
 * ativo); CNH, CPF, observação e contato completo só vêm no GET por id.
 */
export async function fetchAllMotoristasDetailed(): Promise<MotoristaRastreame[]> {
  const lista = await fetchAllMotoristas();
  const out: MotoristaRastreame[] = [];
  for (const item of lista) {
    const key = refKeyMotorista(item);
    if (!key) continue;
    try {
      out.push(await fetchMotoristaByKey(key));
    } catch {
      out.push(item);
    }
  }
  return out;
}

async function fetchMotoristaListFromResponse(r: Response): Promise<MotoristaRastreame[]> {
  const raw = await r.text();
  if (!r.ok) {
    throw new Error(`HTTP ${r.status} ao listar motoristas: ${raw.slice(0, 200)}`);
  }
  let d: unknown;
  try {
    d = JSON.parse(raw);
  } catch {
    throw new Error(`Resposta inválida ao listar motoristas: ${raw.slice(0, 200)}`);
  }
  if (d && typeof d === "object" && "message" in d && !("content" in d)) {
    throw new Error(`Rastreame: ${String((d as { message?: string }).message)}`);
  }
  if (Array.isArray(d)) return d as MotoristaRastreame[];
  const page = d as { content?: MotoristaRastreame[] };
  return page.content ?? [];
}

function refKeyMotorista(m: MotoristaRastreame): string {
  return String(m.key ?? m.id ?? "");
}

export async function fetchMotoristaByKey(key: string | number): Promise<MotoristaRastreame> {
  const r = await fetchRastreameWith401Retry(`${MOTORISTA_BASE}/${key}`, {
    headers: await rastreameJsonHeaders(false),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`motorista GET ${key} HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as MotoristaRastreame;
}

export async function postMotoristaPayload(body: unknown): Promise<MotoristaRastreame> {
  const r = await fetchRastreameWith401Retry(`${MOTORISTA_BASE}/`, {
    method: "POST",
    headers: await rastreameJsonHeaders(true),
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`motorista POST HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as MotoristaRastreame;
}

export async function putMotorista(key: string | number, body: unknown): Promise<void> {
  const r = await fetchRastreameWith401Retry(`${MOTORISTA_BASE}/${key}`, {
    method: "PUT",
    headers: await rastreameJsonHeaders(true),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`motorista PUT ${key} HTTP ${r.status}: ${t.slice(0, 300)}`);
  }
}

export async function inativarMotorista(key: string | number): Promise<void> {
  const atual = await fetchMotoristaByKey(key);
  await putMotorista(key, { ...atual, ativo: false });
}

export async function postMotorista(clienteJsonPath: string): Promise<void> {
  const c = JSON.parse(
    fs.readFileSync(clienteJsonPath, "utf8"),
  ) as Cliente;
  const cnh = (c.cnh ?? {}) as Record<string, string>;
  const ja = await findMotorista(cnh.numeroRegistro ?? "", String(c.nome ?? ""));
  if (ja) {
    console.log(
      `JA CADASTRADO no rastreame: ${ja.nome} (id ${ja.id}) — nada a fazer.`,
    );
    return;
  }
  const payload = buildMotoristaPayload(c);
  const created = await postMotoristaPayload(payload);
  console.log(`CADASTRADO no rastreame: ${payload.nome} (key ${created.key ?? created.id})`);
}
