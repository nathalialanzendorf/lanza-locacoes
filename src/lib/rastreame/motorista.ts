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
  observacao?: string;
  categoriaCnh?: { key?: string; value?: string };
  vencimentoCnh?: string;
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

export function montarObservacaoMotorista(c: Cliente): string {
  const cnh = (c.cnh ?? {}) as Record<string, string>;
  const linhas: string[] = [];
  if (c.cpf) linhas.push(`CPF: ${c.cpf}`);
  if (c.rg) {
    let s = `RG: ${c.rg}`;
    if (c.rgOrgaoExpedidor) s += ` ${c.rgOrgaoExpedidor}`;
    linhas.push(s);
  }
  if (c.dataNascimento) {
    let s = `Nascimento: ${c.dataNascimento}`;
    if (c.localNascimento) s += ` - ${c.localNascimento}`;
    linhas.push(s);
  }
  if (cnh.primeiraHabilitacao) {
    linhas.push(`1a Habilitacao: ${cnh.primeiraHabilitacao}`);
  }
  if (cnh.dataEmissao) linhas.push(`Emissao CNH: ${cnh.dataEmissao}`);
  if (cnh.numeroEspelho) linhas.push(`Espelho: ${cnh.numeroEspelho}`);
  if (cnh.orgaoEmissor || cnh.ufEmissor) {
    linhas.push(
      `Orgao emissor: ${cnh.orgaoEmissor ?? ""}/${cnh.ufEmissor ?? ""}`,
    );
  }
  if (c.filiacao) linhas.push(`Filiacao: ${c.filiacao}`);
  if (c.telefone) linhas.push(`Telefone: ${c.telefone}`);
  const end = (c.endereco ?? {}) as Record<string, string>;
  if (Object.values(end).some(Boolean)) {
    const e = `${end.logradouro ?? ""}, ${end.numero ?? ""} ${end.bairro ?? ""} - ${end.cidade ?? ""}/${end.uf ?? ""} ${end.cep ?? ""}`;
    linhas.push("Endereco: " + e.replace(/\s+/g, " ").trim());
  }
  return linhas.join("\n");
}

export function buildMotoristaPayload(c: Cliente): Record<string, unknown> {
  const cnh = (c.cnh ?? {}) as Record<string, string>;
  return {
    nome: c.nome,
    cnh: cnh.numeroRegistro,
    categoriaCnh: cnh.categoria ? { key: cnh.categoria } : undefined,
    observacao: montarObservacaoMotorista(c),
    vencimentoCnh: br2iso(cnh.validade),
    vencimentoToxicologico: null,
    ativo: c.ativo !== false,
  };
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

async function fetchMotoristaListFromResponse(r: Response): Pr