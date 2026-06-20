/**
 * Atualiza `database/veiculos.json`: `fipe`, `fipeCodigo`, `fipeModelo`,
 * `fipeValor`, `fipeReferencia` via API parallelum (mesma base que fipe.py).
 *
 * Uso (na raiz do repo):
 *   node .cursor/skills/cadastrar-veiculo/scripts/atualizar_fipe_veiculos.mjs
 *   node .../atualizar_fipe_veiculos.mjs --placa ABC1D23   # só essa placa
 *
 * `EXTRAS_BY_PLACA`: motor/portas quando o CRLV não basta ou o `fipeModelo`
 * está desatualizado (ex.: AVU-6740 4p, MLN-0B87 1.6).
 *
 * Em ambientes com falha de verificação TLS/revogação, o script usa
 * rejectUnauthorized: false apenas para estes GETs públicos.
 */
import fs from "fs";
import https from "https";

const ROOT = new URL("../../../../", import.meta.url);
const DB = new URL("database/veiculos.json", ROOT);

const API_HOST = "fipe.parallelum.com.br";
const API_BASE = "/api/v2/cars";

const BRAND_HINTS = {
  VW: ["vw", "volks"],
  HYUNDAI: ["hyundai"],
  FORD: ["ford"],
  FIAT: ["fiat"],
  RENAULT: ["renault"],
  PEUGEOT: ["peugeot"],
};

/** Texto extra só para pontuação / motor / portas (CRLV incompleto ou fipeModelo desatual). */
const EXTRAS_BY_PLACA = {
  "AVU-6740": "4p",
  "MLN-0B87": "1.6",
};

const agent = new https.Agent({ rejectUnauthorized: false });

function get(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: API_HOST,
      path: API_BASE + path,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; LanzaFipeSync/1)" },
      agent,
    };
    https
      .get(opts, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`JSON ${path}: ${e.message}`));
          }
        });
      })
      .on("error", reject);
  });
}

const _MES = {
  janeiro: 1,
  fevereiro: 2,
  março: 3,
  marco: 3,
  abril: 4,
  maio: 5,
  junho: 6,
  julho: 7,
  agosto: 8,
  setembro: 9,
  outubro: 10,
  novembro: 11,
  dezembro: 12,
};

function refParaMesano(ref) {
  const m = String(ref || "")
    .toLowerCase()
    .match(/([a-zçãéíóúâ]+)\s+de\s+(\d{4})/);
  if (!m) return "";
  const mo = _MES[m[1]] || 0;
  return mo ? `${mo}-${m[2]}` : "";
}

function slugMarca(nome) {
  const n = String(nome || "")
    .trim()
    .toLowerCase();
  if (["vw", "volkswagen", "vw-volkswagen"].includes(n)) return "vw-volkswagen";
  return n.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function anoReferencia(anoModelo) {
  const s = String(anoModelo || "").trim();
  const parts = s.split("/").map((x) => x.trim());
  if (parts.length >= 2 && /^\d{4}$/.test(parts[1])) return parseInt(parts[1], 10);
  if (parts.length >= 1 && /^\d{4}$/.test(parts[0])) return parseInt(parts[0], 10);
  return null;
}

function hintBlob(v) {
  const extra = EXTRAS_BY_PLACA[v.placa] || "";
  return `${v.marcaModelo || ""} ${v.fipeModelo || ""} ${extra}`.toLowerCase();
}

function tokensFromHints(marcaModelo, fipeModelo, extraLower) {
  const rest = (marcaModelo || "").split("/").slice(1).join(" ");
  const raw = `${rest} ${fipeModelo || ""} ${extraLower || ""}`.toLowerCase();
  return [
    ...new Set(
      raw
        .split(/[^a-z0-9çãéíóúâ]+/)
        .filter((t) => t.length >= 2)
    ),
  ];
}

function scoreModel(nameLower, toks) {
  let s = 0;
  for (const t of toks) {
    if (nameLower.includes(t)) s += t.length >= 4 ? 3 : 2;
  }
  return s;
}

/** Motores tipo 1.0, 1.6: prioriza `marcaModelo` + extras (evita fipeModelo desatual). */
function engineVersionsFromHints(v) {
  const mm = (v.marcaModelo || "").toLowerCase();
  const ex = (EXTRAS_BY_PLACA[v.placa] || "").toLowerCase();
  const chunk = `${mm} ${ex}`;
  let engines = [...chunk.matchAll(/\b(\d\.\d)\b/g)].map((m) => m[1]);
  engines = [...new Set(engines)];
  if (engines.length) return engines;
  const fm = (v.fipeModelo || "").toLowerCase();
  return [...new Set([...fm.matchAll(/\b(\d\.\d)\b/g)].map((m) => m[1]))];
}

/** Portas: primeiro `EXTRAS_BY_PLACA`, depois marcaModelo, por último fipeModelo. */
function doorFromHints(v) {
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

/** Exige `Xp` quando `doorFromHints` indicar. */
function doorConstraint(v, nameLower) {
  const want = doorFromHints(v);
  if (!want) return 0;
  if (nameLower.includes(want)) return 40;
  for (const d of ["2p", "3p", "4p", "5p"]) {
    if (d !== want && nameLower.includes(d)) return -1e9;
  }
  return -12;
}

function scoreModelFull(m, v) {
  const hintsLower = hintBlob(v);
  const nl = m.name.toLowerCase();
  const toks = tokensFromHints(v.marcaModelo, v.fipeModelo, EXTRAS_BY_PLACA[v.placa] || "");
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

function findBrand(brands, prefix) {
  const p = String(prefix || "").trim().toUpperCase();
  const hints = BRAND_HINTS[p] || [p.toLowerCase()];
  return brands.find((b) => {
    const n = b.name.toLowerCase();
    return hints.some((h) => n.includes(h));
  });
}

function yearRows(years) {
  return years
    .map((e) => {
      const m = e.name.match(/\b(20\d{2})\b/);
      return m ? { code: e.code, name: e.name, yr: parseInt(m[1], 10) } : null;
    })
    .filter(Boolean);
}

function pickYearCode(years, targetYear, hintsLower) {
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
  return pool[0].code;
}

async function resolveVehicle(v, brands) {
  const marcaModelo = v.marcaModelo || "";
  const prefix = marcaModelo.split("/")[0]?.trim() || "";
  const brand = findBrand(brands, prefix);
  if (!brand) throw new Error(`marca não encontrada: ${prefix} (${v.placa})`);

  const models = await get(`/brands/${brand.code}/models`);
  const scored = models
    .map((m) => ({ m, sc: scoreModelFull(m, v) }))
    .filter((x) => x.sc > -1e8)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, 12);

  if (!scored.length) {
    throw new Error(`modelo não encontrado: ${marcaModelo} (${v.placa})`);
  }

  const targetY = anoReferencia(v.anoModelo);
  if (!targetY) throw new Error(`ano modelo inválido: ${v.anoModelo} (${v.placa})`);

  const hints = hintBlob(v);

  /** Entre os modelos bem pontuados, prefere o que aproxima `modelYear` do ano do CRLV. */
  let bestD = null;
  let bestDist = 1e9;
  let bestSc = -1e10;

  for (const { m, sc } of scored) {
    let years;
    try {
      years = await get(`/brands/${brand.code}/models/${m.code}/years`);
    } catch {
      continue;
    }
    const ycode = pickYearCode(years, targetY, hints);
    if (!ycode) continue;
    let d;
    try {
      d = await get(
        `/brands/${brand.code}/models/${m.code}/years/${ycode}`
      );
    } catch {
      continue;
    }
    const my = parseInt(d.modelYear, 10);
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

  const marca_slug = slugMarca(bestD.brand || brand.name);
  const mesano = refParaMesano(bestD.referenceMonth);
  const url = `https://veiculos.fipe.org.br?carro/${marca_slug}/${mesano}/${bestD.codeFipe}/${bestD.modelYear}`;

  return {
    fipe: url,
    fipeCodigo: bestD.codeFipe,
    fipeModelo: bestD.model,
    fipeValor: bestD.price,
    fipeReferencia: bestD.referenceMonth,
  };
}

function parseArgs() {
  const argv = process.argv.slice(2);
  let placaFilter = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--placa" && argv[i + 1]) {
      placaFilter = argv[i + 1];
      i++;
    }
  }
  return { placaFilter };
}

function normPlaca(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

async function main() {
  const { placaFilter } = parseArgs();
  const raw = fs.readFileSync(DB, "utf8");
  const data = JSON.parse(raw);
  const brands = await get("/brands");
  const errors = [];

  const lista = placaFilter
    ? data.veiculos.filter((v) => normPlaca(v.placa) === normPlaca(placaFilter))
    : data.veiculos;

  if (placaFilter && lista.length === 0) {
    console.error("Placa nao encontrada em veiculos.json:", placaFilter);
    process.exit(1);
  }

  for (const v of lista) {
    try {
      const upd = await resolveVehicle(v, brands);
      Object.assign(v, upd);
      if (v.placa === "RAH-4F54" && v.observacao && /fipe/i.test(v.observacao)) {
        delete v.observacao;
      }
      console.log("OK", v.placa, "->", upd.fipeCodigo, upd.fipeModelo);
    } catch (e) {
      console.error("ERRO", v.placa, e.message);
      errors.push({ placa: v.placa, erro: e.message });
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  data.atualizadoEm = today;
  fs.writeFileSync(DB, JSON.stringify(data, null, 2) + "\n", "utf8");

  if (errors.length) {
    console.error("\nFalhas:", JSON.stringify(errors, null, 2));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
