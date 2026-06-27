/**
 * Autenticação e headers HTTP para o DETRAN RS (PROCERGS / pcsdetran).
 *
 * A API do RS é uma única chamada GET por veículo (sem ticket/captcha como o SC):
 *   GET /pcsdetran/rest/veiculos/{PLACA}/?renavam={RENAVAM}&contabiliza=false
 *
 * Credenciais capturadas no portal (pcsdetran.rs.gov.br → DevTools → Network):
 *   - Authorization: Bearer <token>  → DETRAN_RS_AUTH
 *   - X-User-Id: <base64 do CPF>      → DETRAN_RS_USER_ID
 */
import { loadLocalEnv } from "../loadLocalEnv.js";

loadLocalEnv();

// Redes com interceptação TLS (proxy/firewall) fazem o Node falhar com
// UNABLE_TO_VERIFY_LEAF_SIGNATURE. Mesma necessidade do DETRAN SC/Rastreame.
if (
  process.env.DETRAN_RS_TLS_INSECURE === "1" ||
  process.env.DETRAN_SC_TLS_INSECURE === "1" ||
  process.env.RASTREAME_TLS_INSECURE === "1"
) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

export const DETRAN_RS_ORIGIN = "https://pcsdetran.rs.gov.br";
export const DETRAN_RS_API_BASE =
  "https://pcsdetran.procergs.com.br/pcsdetran/rest";

export function requireDetranRsAuth(): string {
  const t = process.env.DETRAN_RS_AUTH?.trim();
  if (!t) {
    console.error(
      "ERRO: defina DETRAN_RS_AUTH (Bearer) nas variáveis de ambiente do utilizador/sistema — não use `.env` para credenciais.",
    );
    console.error(
      "Obter em pcsdetran.rs.gov.br → DevTools → Network → pedido com Authorization.",
    );
    process.exit(2);
  }
  return t.startsWith("Bearer ") ? t.slice(7) : t;
}

export function requireDetranRsUserId(): string {
  const u = process.env.DETRAN_RS_USER_ID?.trim();
  if (!u) {
    console.error(
      "ERRO: defina DETRAN_RS_USER_ID (header X-User-Id, base64 do CPF) nas variáveis de ambiente do utilizador/sistema.",
    );
    process.exit(2);
  }
  return u;
}

export function detranRsJsonHeaders(): Record<string, string> {
  return {
    Accept: "application/json, text/plain, */*",
    Authorization: `Bearer ${requireDetranRsAuth()}`,
    Origin: DETRAN_RS_ORIGIN,
    Referer: `${DETRAN_RS_ORIGIN}/`,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "X-User-Id": requireDetranRsUserId(),
  };
}
