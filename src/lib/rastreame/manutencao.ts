/**
 * API /keek/rest/manutencao — tela "Manutenção" do Rastreame.
 *
 * Destino das **despesas de parceiro/dono** (Seguro, Rastreador, IPVA,
 * Licenciamento, Manutenção, etc.). As despesas de cliente/locatário vão
 * para Gastos Gerais (ver `gasto.ts`).
 *
 * Corpo de referência (POST, capturado no DevTools):
 *   {"status":{"key":"DONE"},"listPeca":[],"pecas":0,"servico":50,"total":50,
 *    "rastreavel":{"key":"110"},"odometro":0,"horimetro":0,
 *    "tipo":{"key":"OUTROS"},"info":"Rastreador","data":"2026-07-10"}
 *
 * A listagem usa parâmetros típicos Spring Data; se falhar, ajustar a query
 * conforme o XHR capturado na UI de manutenções.
 */
import { RASTREAME_ORIGIN, rastreameJsonHeaders } from "./auth.js";
import { fetchRastreameWith401Retry } from "./fetchRetry.js";

const MANUTENCAO_ROOT = `${RASTREAME_ORIGIN}/keek/rest/manutencao`;

export type ManutencaoRecord = Record<string, unknown> & {
  id?: number | string;
  info?: string;
  total?: number;
  servico?: number;
  data?: string;
  status?: { key?: string; value?: string };
  tipo?: { key?: string; value?: string };
  rastreavel?: { key?: string; id?: string | number; value?: string };
  ativo?: boolean;
};

/**
 * Heurística de "pago/quitado" a partir do status da Manutenção no Rastreame.
 * O push usa `DONE` (concluído) por defeito; só consideramos baixa quando o
 * status indica pagamento explícito (evita falso-positivo com `DONE`).
 */
export function manutencaoPaga(m: ManutencaoRecord): boolean {
  const s = m.status ?? {};
  const key = String(s.key ?? "").toUpperCase();
  const val = String(s.value ?? "").toLowerCase();
  if (["PAGO", "PAGA", "PAID", "QUITADO", "QUITADA"].includes(key)) return true;
  return /\bpag|quitad/.test(val);
}

export type MontarCorpoManutencaoInput = {
  rastreavelKey: string | number;
  info: string;
  valor: number;
  /** Data no formato YYYY-MM-DD (a API de Manutenção usa data sem hora). */
  data: string;
  tipoKey?: string;
  statusKey?: string;
};

/** Monta o corpo de POST/PUT de Manutenção a partir de uma despesa de parceiro. */
export function montarCorpoManutencao(
  input: MontarCorpoManutencaoInput,
): Record<string, unknown> {
  const valor = Math.round(Number(input.valor) * 100) / 100;
  return {
    status: { key: input.statusKey ?? "DONE" },
    listPeca: [],
    pecas: 0,
    servico: valor,
    total: valor,
    rastreavel: { key: String(input.rastreavelKey) },
    odometro: 0,
    horimetro: 0,
    tipo: { key: input.tipoKey ?? "OUTROS" },
    info: input.info,
    data: input.data,
  };
}

export type ListManutencoesParams = {
  page?: number;
  size?: number;
  dataInicial?: string;
  dataFinal?: string;
};

// A API de Manutenção espera data SEM hora (yyyy-MM-dd). Enviar ISO completo
// (…T00:00:00.000Z) faz o backend responder HTTP 400 "unparsed text at index 10".
function dataInicioAno(ano: number): string {
  return `${ano}-01-01`;
}

function dataFimAno(ano: number): string {
  return `${ano}-12-31`;
}

/** GET lista paginada (resposta JSON crua). */
export async function fetchManutencoesList(
  params: ListManutencoesParams = {},
): Promise<Response> {
  const page = params.page ?? 0;
  const size = params.size ?? 50;
  const anoAtual = new Date().getFullYear();
  const q = new URLSearchParams({
    dataInicial: params.dataInicial ?? dataInicioAno(anoAtual),
    dataFinal: params.dataFinal ?? dataFimAno(anoAtual),
    page: String(page),
    size: String(size),
  });
  return fetchRastreameWith401Retry(`${MANUTENCAO_ROOT}?${q.toString()}`, {
    method: "GET",
    headers: await rastreameJsonHeaders(false),
  });
}

/** POST cria manutenção. */
export async function postManutencao(body: unknown): Promise<Response> {
  return fetchRastreameWith401Retry(`${MANUTENCAO_ROOT}/`, {
    method: "POST",
    headers: await rastreameJsonHeaders(true),
    body: JSON.stringify(body),
  });
}

/** PUT atualiza manutenção existente. */
export async function putManutencao(id: string | number, body: unknown): Promise<Response> {
  return fetchRastreameWith401Retry(`${MANUTENCAO_ROOT}/${id}`, {
    method: "PUT",
    headers: await rastreameJsonHeaders(true),
    body: JSON.stringify(body),
  });
}

/** GET uma manutenção pelo id (corpo completo para PUT). */
export async function fetchManutencaoById(id: string | number): Promise<ManutencaoRecord> {
  const r = await fetchRastreameWith401Retry(`${MANUTENCAO_ROOT}/${id}`, {
    method: "GET",
    headers: await rastreameJsonHeaders(false),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`manutencao GET ${id} HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as ManutencaoRecord;
}

const MANUTENCAO_ANO_INICIAL = 2025;

function parseManutencoesBody(body: unknown): { itens: ManutencaoRecord[]; paginado: boolean } {
  if (Array.isArray(body)) return { itens: body as ManutencaoRecord[], paginado: false };
  const page = body as { content?: ManutencaoRecord[] };
  if (Array.isArray(page?.content)) return { itens: page.content, paginado: true };
  return { itens: [], paginado: false };
}

async function fetchManutencoesIntervalo(
  dataInicial: string,
  dataFinal: string,
  size: number,
): Promise<ManutencaoRecord[]> {
  const out: ManutencaoRecord[] = [];
  let page = 0;
  for (;;) {
    const r = await fetchManutencoesList({ page, size, dataInicial, dataFinal });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`manutencao list HTTP ${r.status}: ${t.slice(0, 300)}`);
    }
    const { itens, paginado } = parseManutencoesBody(await r.json());
    out.push(...itens);
    if (!paginado || itens.length < size) break;
    page++;
    if (page > 500) break;
  }
  return out;
}

/**
 * Lista todas as manutenções, iterando por janelas anuais e deduplicando por id.
 * Tolerante a falha de listagem: devolve `[]` (o dedupe passa a depender do
 * `rastreameManutencaoId` guardado localmente).
 */
export async function fetchAllManutencoes(size = 100): Promise<ManutencaoRecord[]> {
  const anoFinal = new Date().getFullYear() + 1;
  const porId = new Map<string, ManutencaoRecord>();
  const semId: ManutencaoRecord[] = [];
  for (let ano = MANUTENCAO_ANO_INICIAL; ano <= anoFinal; ano++) {
    const chunk = await fetchManutencoesIntervalo(dataInicioAno(ano), dataFimAno(ano), size);
    for (const m of chunk) {
      if (m.id != null) porId.set(String(m.id), m);
      else semId.push(m);
    }
  }
  return [...porId.values(), ...semId];
}

/** Exclusão lógica no Rastreame (ativo=false). */
export async function inativarManutencao(id: string | number): Promise<void> {
  const m = await fetchManutencaoById(id);
  const r = await putManutencao(id, { ...m, ativo: false });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`manutencao inativar ${id} HTTP ${r.status}: ${t.slice(0, 300)}`);
  }
}
