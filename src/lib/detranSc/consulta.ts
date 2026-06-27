import { compactPlaca } from "../placa.js";
import {
  DETRAN_SC_API_BASE,
  detranScJsonHeaders,
} from "./auth.js";
import type { DetranScConsultaVeiculo } from "./types.js";

// Início da consulta: GET /veiculo/requisitar-consulta?p=PLACA&r=RENAVAM&c=CAPTCHA&v=
// Devolve o ticket (UUID) usado em /veiculo/resposta-consulta?t=TICKET.
// `c` é um token de captcha gerado no browser (uso único, ~curta validade).
const REQUISITAR_PATH = "/veiculo/requisitar-consulta";
const RESPOSTA_PATH = "/veiculo/resposta-consulta";

/** Erro de consulta DETRAN com mensagem do portal (ex.: "Captcha inválido"). */
export class DetranScConsultaError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pickTicket(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  for (const k of ["t", "ticket", "uuid", "id", "protocolo", "token"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const nested = [o.data, o.resultado, o.payload].find((x) => x && typeof x === "object");
  if (nested) return pickTicket(nested);
  return null;
}

/** Alguns endpoints devolvem o ticket como string nua (UUID) em vez de objeto. */
function pickTicketFromString(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().replace(/^"|"$/g, "");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return s;
  return null;
}

function hasVeiculoPayload(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  // pendente:true = consulta ainda processando (resposta-consulta devolve
  // {placa,pendente:true,...} enquanto monta o dossiê) — não é o payload final.
  if (o.pendente === true) return false;
  const check = (x: Record<string, unknown>) =>
    Array.isArray(x.infracoes) ||
    Array.isArray(x.historicoInfracoes) ||
    Array.isArray(x.debitos) ||
    x.placa != null;

  if (check(o)) return true;
  for (const k of ["data", "veiculo", "resultado", "payload", "content"]) {
    const nested = o[k];
    if (nested && typeof nested === "object" && check(nested as Record<string, unknown>)) {
      return true;
    }
  }
  return false;
}

/** Extrai mensagem de erro do portal (array/obj com `mensagemUsuario`/`message`). */
function extrairMensagemErro(raw: unknown): string | null {
  const fromObj = (o: Record<string, unknown>): string | null => {
    for (const k of ["mensagemUsuario", "mensagem", "message", "erro", "error"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === "object") {
        const m = fromObj(item as Record<string, unknown>);
        if (m) return m;
      }
    }
    return null;
  }
  if (raw && typeof raw === "object") return fromObj(raw as Record<string, unknown>);
  return null;
}

/**
 * Inicia a consulta em `requisitar-consulta` e devolve o ticket.
 *
 * O parâmetro `c` (captcha Cloudflare) é **opcional**: o backend devolve o
 * ticket apenas com `p` (+ `r`) — ex.: `{"pendente":true,"token":"<uuid>"}`.
 * Mantemos `captcha` aceito caso o browser o forneça, mas não é exigido, o que
 * permite a varredura automática da frota.
 */
async function iniciarConsulta(
  placa: string,
  renavam: string,
  captcha: string | undefined,
): Promise<{ ticket: string | null; direct: DetranScConsultaVeiculo | null }> {
  const placaApi = compactPlaca(placa);
  const renavamApi = String(renavam).replace(/\D/g, "");
  const debug = process.env.DETRAN_SC_DEBUG === "1";

  // `c` já vem URL-safe do browser; não re-encodar para não corromper o token.
  const cParam = captcha && captcha.trim() ? captcha.trim() : "";
  const url =
    `${DETRAN_SC_API_BASE}${REQUISITAR_PATH}` +
    `?p=${encodeURIComponent(placaApi)}&r=${encodeURIComponent(renavamApi)}&c=${cParam}&v=`;

  const r = await fetch(url, { headers: detranScJsonHeaders() });
  const text = await r.text();
  if (debug) {
    console.error(`[detran-debug] GET requisitar-consulta p=${placaApi} → HTTP ${r.status}: ${text.slice(0, 400)}`);
  }

  let raw: unknown = null;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = text.trim() || null;
  }

  const msgErro = extrairMensagemErro(raw);
  if (msgErro) throw new DetranScConsultaError(`DETRAN SC requisitar-consulta: ${msgErro}`);

  if (r.ok && hasVeiculoPayload(raw)) {
    return { ticket: null, direct: raw as DetranScConsultaVeiculo };
  }

  const ticket = pickTicketFromString(raw) ?? pickTicket(raw);
  if (ticket) return { ticket, direct: null };

  throw new DetranScConsultaError(
    `DETRAN SC: requisitar-consulta não devolveu ticket (HTTP ${r.status}).`,
  );
}

async function buscarResposta(ticket: string): Promise<DetranScConsultaVeiculo> {
  const url = `${DETRAN_SC_API_BASE}${RESPOSTA_PATH}?t=${encodeURIComponent(ticket)}`;
  const delays = [500, 1000, 1500, 2000, 2500, 3000];

  for (let i = 0; i < delays.length; i++) {
    const r = await fetch(url, { headers: detranScJsonHeaders() });
    const raw = await r.json().catch(() => ({}));

    if (r.status === 202 || r.status === 204) {
      await sleep(delays[i]!);
      continue;
    }

    if (!r.ok) {
      const msg =
        typeof raw === "object" && raw && "message" in raw
          ? String((raw as { message: unknown }).message)
          : `HTTP ${r.status}`;
      throw new Error(`DETRAN SC resposta-consulta: ${msg}`);
    }

    if (hasVeiculoPayload(raw)) return raw as DetranScConsultaVeiculo;

    const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const pendente =
      o.pendente === true ||
      (("status" in o || "situacao" in o) &&
        /process|pendente|aguard/i.test(String(o.status ?? o.situacao)));

    if (pendente) {
      await sleep(delays[i]!);
      continue;
    }

    return raw as DetranScConsultaVeiculo;
  }

  throw new Error("DETRAN SC: timeout aguardando resposta-consulta");
}

/** Consulta veículo no portal Detran Digital SC (placa + renavam + captcha). */
export async function consultarVeiculoDetranSc(
  placa: string,
  renavam: string,
  opts?: { captcha?: string },
): Promise<DetranScConsultaVeiculo> {
  const { ticket, direct } = await iniciarConsulta(placa, renavam, opts?.captcha);
  if (direct) return direct;
  if (!ticket) {
    throw new Error(
      "DETRAN SC: não foi possível iniciar consulta (verifique token, X-Empresa e placa/renavam).",
    );
  }
  return buscarResposta(ticket);
}

/** Busca resposta quando o operador já tem o ticket `t` copiado do DevTools. */
export async function consultarVeiculoDetranScPorTicket(
  ticket: string,
): Promise<DetranScConsultaVeiculo> {
  return buscarResposta(ticket.trim());
}
