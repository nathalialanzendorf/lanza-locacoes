/**
 * Autenticação e headers HTTP para servicos.detran.sc.gov.br / transito-api.
 */
import { loadLocalEnv } from "../loadLocalEnv.js";

loadLocalEnv();

// Redes com interceptação TLS (proxy/firewall) fazem o Node falhar com
// UNABLE_TO_VERIFY_LEAF_SIGNATURE ao chamar backend.detran.sc.gov.br.
// Mesma necessidade do Rastreame/Pedágio — ativar via DETRAN_SC_TLS_INSECURE=1.
if (
  process.env.DETRAN_SC_TLS_INSECURE === "1" ||
  process.env.RASTREAME_TLS_INSECURE === "1"
) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

export const DETRAN_SC_ORIGIN = "https://servicos.detran.sc.gov.br";
export const DETRAN_SC_API_BASE =
  "https://backend.detran.sc.gov.br/transito-api";

const DEFAULT_APP_VERSION = "2026-06-26-1612";

export function detranScAppVersion(): string {
  return process.env.DETRAN_SC_APP_VERSION?.trim() || DEFAULT_APP_VERSION;
}

export function requireDetranScAuth(): string {
  const t = process.env.DETRAN_SC_AUTH?.trim();
  if (!t) {
    console.error(
      "ERRO: defina DETRAN_SC_AUTH (Bearer JWT) nas variáveis de ambiente do utilizador/sistema — não use `.env` para credenciais.",
    );
    console.error(
      "Obter em servicos.detran.sc.gov.br → DevTools → Network → pedido com Authorization.",
    );
    process.exit(2);
  }
  return t.startsWith("Bearer ") ? t.slice(7) : t;
}

export function requireDetranScEmpresa(): string {
  const e = process.env.DETRAN_SC_EMPRESA?.trim();
  if (!e) {
    console.error(
      "ERRO: defina DETRAN_SC_EMPRESA (header X-Empresa) nas variáveis de ambiente do utilizador/sistema.",
    );
    process.exit(2);
  }
  return e;
}

export function detranScJsonHeaders(): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    Authorization: `Bearer ${requireDetranScAuth()}`,
    Origin: DETRAN_SC_ORIGIN,
    Referer: `${DETRAN_SC_ORIGIN}/`,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "X-App-Version": detranScAppVersion(),
    "X-Empresa": requireDetranScEmpresa(),
  };
}
