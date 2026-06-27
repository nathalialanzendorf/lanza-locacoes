import fs from "node:fs";
import path from "node:path";

import { compactPlaca } from "./placa.js";
import { REPO_ROOT } from "./repoRoot.js";

/**
 * UF de registro de um veículo (campo `ufRegistro` em veiculos.json), em
 * maiúsculas. Vazio quando ausente (assume-se SC por histórico).
 * Define qual DETRAN consultar: "RS" → tool detran-rs; demais → detran-sc.
 */
export function ufRegistroDaPlaca(placa: string): string {
  const p = path.join(REPO_ROOT, "database", "veiculos.json");
  const j = JSON.parse(fs.readFileSync(p, "utf8")) as {
    veiculos?: { placa?: string; ufRegistro?: string }[];
  };
  const key = compactPlaca(placa);
  const v = (j.veiculos ?? []).find((x) => x.placa && compactPlaca(x.placa) === key);
  return String(v?.ufRegistro ?? "").toUpperCase();
}
