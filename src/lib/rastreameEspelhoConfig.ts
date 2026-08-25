/**
 * Espelho Rastreame — opcional. A fonte da verdade é sempre database/ (Lanza).
 *
 * Prioridade: LANZA_RASTREAME_ESPELHO (env) > config/lanza_paths.json > default.
 */
import fs from "node:fs";
import path from "node:path";

import { REPO_ROOT } from "./repoRoot.js";

export type RastreameEspelhoConfig = {
  /** Replicação automática para o Rastreame ativa. */
  ativo: boolean;
  /** Origem da configuração efetiva. */
  origem: "env" | "config" | "default";
  /** Env pode ser alterado só no servidor (Vercel / variáveis de utilizador). */
  editavelViaApi: boolean;
  depreciado: boolean;
};

function parseBoolEnv(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "sim") return true;
  if (v === "false" || v === "0" || v === "nao" || v === "não") return false;
  return null;
}

function readConfigFile(): Record<string, unknown> {
  const cfgPath = path.join(REPO_ROOT, "config", "lanza_paths.json");
  if (!fs.existsSync(cfgPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Leitura global — espelhar no Rastreame? */
export function rastreameEspelhoGlobal(): boolean {
  const envRaw = process.env.LANZA_RASTREAME_ESPELHO?.trim();
  if (envRaw) {
    const parsed = parseBoolEnv(envRaw);
    if (parsed != null) return parsed;
  }

  const cfg = readConfigFile();
  if (typeof cfg.rastreameEspelho === "boolean") return cfg.rastreameEspelho;

  return false;
}

/** Replica clientes/contratos quando o espelho global está ativo. */
export function rastreameClienteContratoObrigatorio(): boolean {
  return rastreameEspelhoGlobal();
}

function runtimeReadOnly(): boolean {
  return Boolean(process.env.VERCEL);
}

export function obterRastreameEspelhoConfig(): RastreameEspelhoConfig {
  const depreciado = false;
  const envRaw = process.env.LANZA_RASTREAME_ESPELHO?.trim();
  if (envRaw && parseBoolEnv(envRaw) != null) {
    return {
      ativo: rastreameEspelhoGlobal(),
      origem: "env",
      editavelViaApi: false,
      depreciado,
    };
  }

  const cfg = readConfigFile();
  if (typeof cfg.rastreameEspelho === "boolean") {
    return {
      ativo: cfg.rastreameEspelho,
      origem: "config",
      editavelViaApi: !runtimeReadOnly(),
      depreciado,
    };
  }

  return {
    ativo: rastreameEspelhoGlobal(),
    origem: "default",
    editavelViaApi: !runtimeReadOnly(),
    depreciado,
  };
}

/**
 * Resolve se uma operação deve empurrar ao Rastreame.
 * @param perCall false = nunca nesta chamada; true/undefined = segue o global.
 */
export function resolveSyncRastreame(perCall?: boolean): boolean {
  if (!rastreameEspelhoGlobal()) return false;
  if (perCall === false) return false;
  return true;
}

export function gravarRastreameEspelhoConfig(ativo: boolean): RastreameEspelhoConfig {
  if (runtimeReadOnly()) {
    throw new Error(
      "Configuração não pode ser gravada em ficheiro na Vercel (filesystem só leitura). Defina LANZA_RASTREAME_ESPELHO nas variáveis de ambiente do projeto.",
    );
  }

  const atual = obterRastreameEspelhoConfig();
  if (!atual.editavelViaApi) {
    throw new Error(
      "Espelho Rastreame controlado por LANZA_RASTREAME_ESPELHO no servidor — altere a variável de ambiente.",
    );
  }

  const cfgPath = path.join(REPO_ROOT, "config", "lanza_paths.json");
  const cfg = readConfigFile();
  cfg.rastreameEspelho = ativo;
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");

  return obterRastreameEspelhoConfig();
}
