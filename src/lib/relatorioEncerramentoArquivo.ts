import fs from "node:fs";
import path from "node:path";

import type { EncerramentoResult } from "./encerrarContrato.js";
import {
  RELATORIOS_QUEBRA_CONTRATO_DIR,
  ensureRelatoriosDirs,
} from "./relatoriosPaths.js";

export {
  RELATORIOS_DIR,
  RELATORIOS_QUEBRA_CONTRATO_DIR,
  RELATORIOS_ENCERRAMENTO_DIR,
} from "./relatoriosPaths.js";

function slugArquivo(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function dataParaArquivo(dataBr: string): string {
  return dataBr.trim().replace(/\//g, "-");
}

/** Nome base: quebra-contrato-{placa}-{cliente}-{encerramento} */
export function nomeBaseRelatorioEncerramento(r: EncerramentoResult): string {
  const c = r.contrato;
  const placa = slugArquivo(c.placa.replace(/-/g, ""));
  const cliente = slugArquivo(c.clienteNome);
  const enc = dataParaArquivo(r.dataEncerramento);
  return `quebra-contrato-${placa}-${cliente}-${enc}`;
}

export function caminhoRelatorioEncerramentoTxt(
  r: EncerramentoResult,
  relatoriosDir = RELATORIOS_QUEBRA_CONTRATO_DIR,
): string {
  const base = nomeBaseRelatorioEncerramento(r);
  return path.join(relatoriosDir, `${base}.txt`);
}

export type SalvarRelatorioEncerramentoOpts = {
  relatoriosDir?: string;
  /** Sobrescreve caminho do .txt (documento para o cliente). */
  outTxt?: string | null;
  /** Sobrescreve caminho do JSON de dados (default: mesmo base do .txt + .json). */
  outJson?: string | null;
  /** Desliga a gravação do JSON de dados (que alimenta o canvas). */
  semJson?: boolean;
};

export function salvarRelatorioEncerramento(
  result: EncerramentoResult,
  texto: string,
  opts: SalvarRelatorioEncerramentoOpts = {},
): { txt: string; json?: string } {
  const dir = opts.relatoriosDir ?? RELATORIOS_QUEBRA_CONTRATO_DIR;
  ensureRelatoriosDirs();
  fs.mkdirSync(dir, { recursive: true });

  const txtPath = opts.outTxt
    ? path.resolve(opts.outTxt)
    : caminhoRelatorioEncerramentoTxt(result, dir);

  fs.writeFileSync(txtPath, texto, "utf8");

  const out: { txt: string; json?: string } = { txt: txtPath };
  // JSON de dados estruturados (sidecar) — alimenta o canvas. Por padrão grava
  // ao lado do .txt (mesma base + .json); --no-salvar/semJson desliga.
  if (!opts.semJson) {
    const jsonPath = opts.outJson
      ? path.resolve(opts.outJson)
      : txtPath.replace(/\.txt$/i, ".json");
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2), "utf8");
    out.json = jsonPath;
  }

  return out;
}
