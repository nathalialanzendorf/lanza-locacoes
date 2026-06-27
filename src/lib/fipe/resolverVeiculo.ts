/**
 * Resolução automática FIPE a partir dos dados do veículo (marcaModelo,
 * fipeModelo, anoModelo). Heurística de pontuação para escolher o modelo/ano
 * mais provável. Reutilizável por skills (cadastro-veiculo) e CLIs.
 */
import {
  type FipeAno,
  type FipeMarca,
  type FipeModelo,
  type FipeValor,
} from "./client.js";
import {
  consultarValor,
  listarAnos,
  listarMarcas,
  listarModelos,
  montarUrlFipe,
} from "./consulta.js";

const BRAND_HINTS: Record<string, string[]> = {
  VW: ["vw", "volks"],
  HYUNDAI: ["hyundai"],
  FORD: ["ford"],
  FIAT: ["fiat"],
  RENAULT: ["renault"],
  PEUGEOT: ["peugeot"],
};

/** Ajustes manuais por placa (versão/portas) para refinar o match FIPE. */
export const EXTRAS_BY_PLACA: Record<string, string> = {
  "AVU-6740": "4p",
  "MLN-0B87": "1.6",
};

export type VeiculoFipeInput = {
  placa: string;
  marcaModelo?: string;
  fipeModelo?: string;
  anoModelo?: string;
  /** Campos do CRV-e (ex.: vindos do Rastreame) — usados como fallback. */
  marca?: string;
  modelo?: string;
  ano?: number;
  [key: string]: unknown;
};

/**
 * Normaliza a entrada: quando o `marcaModelo` legado não está no formato
 * "MARCA/MODELO", usa os campos do CRV-e (`marca`/`modelo`/`ano`) para montar
 * uma entrada efetiva mais confiável. Não persiste nada (só para a resolução).
 */
function entradaEfetiva(v: VeiculoFipeInput): VeiculoFipeInput {
  const eff: VeiculoFipeInput = { ...v };
  const marca = String(v.marca ?? "").trim();
  const temFormatoBom = String(v.marcaModelo ?? "").includes("/");
  if (marca && !temFormatoBom) {
    const modelo = String(v.modelo ?? "").trim();
    eff.marcaModelo = `${marca}/${modelo}`.replace(/\/$/, "");
  }
  if (!String(eff.anoModelo ?? "").trim() && v.ano) {
    eff.anoModelo = `${v.ano}/${v.ano}`;
  }
  return eff;
}

export type FipeResultado = {
  fipe: string;
  fipeCodigo: string | undefined;
  fipeModelo: string | undefined;
  fipeValor: string | undefined;
  fipeReferencia: string | undefined;
};

function anoReferencia(anoModelo: string): number | null {
  const s = String(anoModelo || "").trim();
  const parts = s.split("/").map((x) => x.trim());
  if (parts.length >= 2 && /^\d{4}$/.test(parts[1]!)) return parseInt(parts[1]!, 10);
  if (parts.length >= 1 && /^\d{4}$/.test(parts[0]!)) return parseInt(parts[0]!, 10);
  return null;
}

function hintBlob(v: VeiculoFipeInput): string {
  const extra = EXTRAS_BY_PLACA[v.placa] || "";
  return `${v.marcaModelo || ""} ${v.fipeModelo || ""} ${extra}`.toLowerCase();
}

function tokensFromHints(
  marcaModelo: string,
  fipeModelo: string,
  extraLower: string,
): string[] {
  const rest = (marcaModelo || "").split("/").slice(1).join(" ");
  const raw = `${rest} ${fipeModelo || ""} ${extraLower || ""}`.toLowerCase();
  return [
    ...new Set(
      raw.split(/[^a-z0-9çãéíóúâ]+/).filter((t) => t.length >= 2),
    ),
  ];
}

function scoreModel(nameLower: string, toks: string[]): number {
  let s = 0;
  for (const t of toks) {
    if (nameLower.includes(t)) s += t.length >= 4 ? 3 : 2;
  }
  return s;
}

function engineVersionsFromHints(v: VeiculoFipeInput): string[] {
  const mm = (v.marcaModelo || "").toLowerCase();
  const ex = (EXTRAS_BY_PLACA[v.placa] || "").toLowerCase();
  const chunk = `${mm} ${ex}`;
  let engines = [...chunk.matchAll(/\b(\d\.\d)\b/g)].map((m) => m[1]!);
  engines = [...new Set(engines)];
  if (engines.length) return engines;
  const fm = (v.fipeModelo || "").toLowerCase();
  return [...new Set([...fm.matchAll(/\b(\d\.\d)\b/g)].map((m) => m[1]!))];
}

function doorFromHints(v: VeiculoFipeInput): string | null {
  const ex = (EXTRAS_BY_PLACA[v.placa] || "").toLowerCase();
  const m0 = ex.match(/\b([2-5])p\b/);
  if (m0) return `${m0[1]}p`;
  const mm = (v.marcaModelo || "").toLowerCase();
  const m1 = mm.match(/\b([2-5])p\b/);
  if (m1) return `${m1[1]}p`;
  const fm = (v.fipeModelo || "").toLowerCase();
  const m2 = fm.match(/\b([2-5])p\b/);
  return m2 ? `${m2[1]}p` : null;
}

function doorConstraint(v: VeiculoFipeInput, nameLower: string): number {
  const want = doorFromHints(v);
  if (!want) return 0;
  if (nameLower.includes(want)) return 40;
  for (const d of ["2p", "3p", "4p", "5p"]) {
    if (d !== want && nameLower.includes(d)) return -1e9;
  }
  return -12;
}

function scoreModelFull(m: { name: string }, v: VeiculoFipeInput): number {
  const hintsLower = hintBlob(v);
  const nl = m.name.toLowerCase();
  const toks = tokensFromHints(
    v.marcaModelo || "",
    v.fipeModelo || "",
    EXTRAS_BY_PLACA[v.placa] || "",
  );
  let sc = scoreModel(nl, toks);

  const engines = engineVersionsFromHints(v);
  for (const e of engines) {
    if (!nl.includes(e)) return -1e9;
  }

  sc += doorConstraint(v, nl);
  if (hintsLower.includes("sedan") && nl.includes("sedan")) sc += 25;
  if (hintsLower.includes("trendline") && nl.includes("trendline")) sc += 25;
  if (hintsLower.includes("allure") && nl.includes("allure")) sc += 25;
  if (hintsLower.includes("style") && nl.includes("style")) sc += 25;
  if (hintsLower.includes("connect") && nl.includes("connect")) sc += 20;
  if (hintsLower.includes("expression") && nl.includes("expression")) sc += 15;

  return sc;
}

function findBrand(brands: FipeMarca[], prefix: string): FipeMarca | undefined {
  const p = String(prefix || "")
    .trim()
    .toUpperCase();
  const hints = BRAND_HINTS[p] || [p.toLowerCase()];
  return brands.find((b) => {
    const n = b.name.toLowerCase();
    return hints.some((h) => n.includes(h));
  });
}

function yearRows(years: FipeAno[]) {
  return years
    .map((e) => {
      const m = e.name.match(/\b(20\d{2})\b/);
      return m ? { code: e.code, name: e.name, yr: parseInt(m[1]!, 10) } : null;
    })
    .filter((x): x is { code: string; name: string; yr: number } => Boolean(x));
}

function pickYearCode(
  years: FipeAno[],
  targetYear: number,
  hintsLower: string,
): string | null {
  let pool = yearRows(years);
  if (!pool.length) return null;

  const flex = /flex/.test(hintsLower);
  const gnv = /gnv/.test(hintsLower);
  if (flex) {
    const fp = pool.filter((e) => /flex/i.test(e.name));
    if (fp.length) pool = fp;
  }
  if (gnv) {
    const g = pool.find((e) => /gnv/i.test(e.name));
    if (g) return g.code;
  }

  const order = [
    targetYear,
    targetYear - 1,
    targetYear + 1,
    targetYear - 2,
    targetYear + 2,
    targetYear - 3,
    targetYear + 3,
  ];
  for (const ty of order) {
    const hit = pool.find((e) => e.yr === ty);
    if (hit) return hit.code;
  }
  pool.sort((a, b) => Math.abs(a.yr - targetYear) - Math.abs(b.yr - targetYear));
  return pool[0]!.code;
}

/**
 * Resolve os campos FIPE de um veículo. Passe `brands` quando processar vários
 * veículos para evitar refazer a chamada `/brands` a cada item.
 */
export async function resolverFipeVeiculo(
  vRaw: VeiculoFipeInput,
  brands?: FipeMarca[],
): Promise<FipeResultado> {
  const v = entradaEfetiva(vRaw);
  const marcas = brands ?? (await listarMarcas());
  const marcaModelo = v.marcaModelo || "";
  const prefix = marcaModelo.split("/")[0]?.trim() || "";
  const brand = findBrand(marcas, prefix);
  if (!brand) throw new Error(`marca não encontrada: ${prefix} (${v.placa})`);

  const models = await listarModelos(brand.code);
  const scored = models
    .map((m: FipeModelo) => ({ m, sc: scoreModelFull(m, v) }))
    .filter((x) => x.sc > -1e8)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, 12);

  if (!scored.length) {
    throw new Error(`modelo não encontrado: ${marcaModelo} (${v.placa})`);
  }

  const targetY = anoReferencia(v.anoModelo || "");
  if (!targetY) throw new Error(`ano modelo inválido: ${v.anoModelo} (${v.placa})`);

  const hints = hintBlob(v);

  let bestD: FipeValor | null = null;
  let bestDist = 1e9;
  let bestSc = -1e10;

  for (const { m, sc } of scored) {
    let years: FipeAno[];
    try {
      years = await listarAnos(brand.code, m.code);
    } catch {
      continue;
    }
    const ycode = pickYearCode(years, targetY, hints);
    if (!ycode) continue;
    let d: FipeValor;
    try {
      d = await consultarValor(brand.code, m.code, ycode);
    } catch {
      continue;
    }
    const my = parseInt(String(d.modelYear), 10);
    if (Number.isNaN(my)) continue;
    const dist = Math.abs(my - targetY);
    if (dist < bestDist || (dist === bestDist && sc > bestSc)) {
      bestDist = dist;
      bestSc = sc;
      bestD = d;
    }
  }

  if (!bestD) {
    throw new Error(`combinação modelo/ano FIPE não encontrada (${v.placa})`);
  }

  return {
    fipe: montarUrlFipe(bestD, brand.name),
    fipeCodigo: bestD.codeFipe,
    fipeModelo: bestD.model,
    fipeValor: bestD.price,
    fipeReferencia: bestD.referenceMonth,
  };
}
