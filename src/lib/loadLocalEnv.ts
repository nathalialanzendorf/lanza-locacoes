/**
 * Carrega `REPO_ROOT/.env` em `process.env` (só chaves ainda não definidas).
 * Credenciais (tokens, login/senha) **não** são lidas daqui — use variáveis de
 * ambiente do utilizador/sistema (Windows: variáveis de ambiente do utilizador).
 */
import fs from "node:fs";
import path from "node:path";

import { REPO_ROOT } from "./repoRoot.js";

let loaded = false;

/** Chaves que nunca devem vir do ficheiro `.env` (só `process.env` do SO). */
const CREDENTIAL_KEYS = new Set([
  "RASTREAME_AUTH",
  "RASTREAME_LOGIN",
  "RASTREAME_SENHA",
  "DETRAN_SC_AUTH",
  "DETRAN_SC_EMPRESA",
  "DETRAN_RS_AUTH",
  "DETRAN_RS_USER_ID",
  "DETRAN_RS_GOV_CPF",
  "DETRAN_RS_GOV_SENHA",
  "DETRAN_RS_PFX_PASS",
  "DETRAN_PFX_PASS",
  "PEDAGIO_DIGITAL_LOGIN",
  "PEDAGIO_DIGITAL_SENHA",
  "PEDAGIO_DIGITAL_COOKIE",
  "PEDAGIO_DIGITAL_CSRF",
]);

export function loadLocalEnv(): void {
  if (loaded) return;
  loaded = true;
  const p = path.join(REPO_ROOT, ".env");
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    if (CREDENTIAL_KEYS.has(key)) continue;
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}
