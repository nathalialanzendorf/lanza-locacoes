/**
 * Mesma lógica que sincronizar_veiculos_crlv.py — usa pdf-parse (Node).
 *
 * Uso (na raiz do repo):
 *   npm install --prefix ".cursor/skills/cadastrar-veiculo/scripts/pdf-deps"
 *   node ".cursor/skills/cadastrar-veiculo/scripts/sincronizar_veiculos_crlv.mjs"
 *   node .../sincronizar_veiculos_crlv.mjs --dry-run
 *   node .../sincronizar_veiculos_crlv.mjs --placa MLN-0B87
 */
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(__dirname, "pdf-deps", "package.json"));
let pdfParse;
try {
  pdfParse = require("pdf-parse");
} catch {
  console.error(
    "Instale dependências:\n" +
      '  npm install --prefix ".cursor/skills/cadastrar-veiculo/scripts/pdf-deps"'
  );
  process.exit(1);
}

const ROOT = path.resolve(__dirname, "../../../../");
const DBV = path.join(ROOT, "database", "veiculos.json");
const CFG = path.join(ROOT, "config", "lanza_paths.json");
const VEIC_DIR = path.join(ROOT, "veiculos");

function compactPlaca(p) {
  return String(p || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function formatPlacaHyphen(p) {
  const c = compactPlaca(p);
  if (c.length === 7) return `${c.slice(0, 3)}-${c.slice(3)}`;
  return c;
}

function loadDocumentosRaiz() {
  if (!fs.existsSync(CFG)) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(CFG, "utf8"));
    const p = cfg.documentosRaiz;
    return p ? p : null;
  } catch {
    return null;
  }
}

function normalizePdfStem(stem) {
  stem = stem.replace(/\s*\(\d+\)\s*$/i, "").trim();
  return compactPlaca(stem);
}

function* walkPdf(dir) {
  if (!fs.existsSync(dir)) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      if (e.isDirectory()) yield* walkPdf(full);
      else if (
        e.isFile() &&
        e.name.toLowerCase().endsWith(".pdf") &&
        !e.name.startsWith("~$")
      )
        yield full;
    } catch {
      /* skip */
    }
  }
}

function collectCrlvIndex(roots) {
  /** @type {Map<string, string[]>} */
  const buckets = new Map();
  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    for (const pdf of walkPdf(root)) {
      const stem = path.basename(pdf, path.extname(pdf));
      const key = normalizePdfStem(stem);
      if (key.length !== 7) continue;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(pdf);
    }
  }
  /** @type {Record<string, string>} */
  const index = {};
  for (const [key, paths] of buckets) {
    paths.sort((a, b) => {
      const da = a.split(path.sep).length;
      const db = b.split(path.sep).length;
      if (da !== db) return da - db;
      return a.localeCompare(b);
    });
    index[key] = paths[0];
  }
  return index;
}

async function extractPdfText(filePath) {
  const buf = fs.readFileSync(filePath);
  const data = await pdfParse(buf);
  return data.text || "";
}

function lineBlocks(text) {
  return text.replace(/\r/g, "\n").split("\n").map((ln) => ln.trim());
}

function nextMeaningful(lines, start) {
  const skip = new Set(["", "-", ".", "..."]);
  for (let j = start; j < Math.min(start + 8, lines.length); j++) {
    const s = lines[j]?.trim() || "";
    if (s && !skip.has(s)) return s;
  }
  return null;
}

function findLineValue(lines, ...labels) {
  for (let i = 0; i < lines.length; i++) {
    const u = lines[i].toUpperCase();
    for (const lab of labels) {
      if (u.includes(lab.toUpperCase()) && lines[i].length < 80) {
        const v = nextMeaningful(lines, i + 1);
        if (v) return v;
      }
    }
  }
  return null;
}

function parseCrlv(text) {
  /** @type {Record<string, string>} */
  const out = {};
  const lines = lineBlocks(text);
  const raw = lines.join("\n");

  let m = raw.match(/CHASSI\s*[:\s]*([A-HJ-NPR-Z0-9]{17})/i);
  if (!m) m = raw.match(/\b([A-HJ-NPR-Z0-9]{17})\b/);
  if (m && m[1].length === 17) out.chassi = m[1].toUpperCase();

  m = raw.match(/RENAVAM\s*[:\s]*(\d{10,11})\b/i);
  if (m) out.renavam = m[1];

  m = raw.match(
    /PLACA\s*[:\s]*([A-Z]{3}[\dA-Z][A-Z0-9]{4}|[A-Z]{3}\d{4})\b/i
  );
  if (m) out.placa_doc = formatPlacaHyphen(m[1]);

  let mm = findLineValue(
    lines,
    "MARCA / MODELO",
    "MARCA/MODELO",
    "MARCA E MODELO",
    "MARCAMODELO"
  );
  if (mm) {
    mm = mm.replace(/\s+/g, " ").trim();
    if (mm.includes("/") || /[A-Z]{2,}/i.test(mm)) {
      out.marcaModelo = /^[\x00-\x7f]+$/.test(mm) ? mm.toUpperCase() : mm;
    }
  }

  const am = findLineValue(lines, "ANO MODELO", "ANO/MODELO", "ANO DO MODELO");
  if (am) {
    const amClean = am.replace(/\s+/g, "");
    let m2 = amClean.match(/(\d{4})\/(\d{4})/);
    if (!m2) m2 = am.match(/(\d{4})\s*\/\s*(\d{4})/);
    if (m2) out.anoModelo = `${m2[1]}/${m2[2]}`;
  }

  let cor = findLineValue(
    lines,
    "COR PREDOMINANTE",
    "COR",
    "COR DO VEÍCULO",
    "COR DO VEICULO"
  );
  if (cor) {
    cor = cor.replace(/\s+/g, " ").trim();
    if (cor.length < 40 && !/^\d+$/.test(cor)) out.cor = cor.toUpperCase();
  }

  if (!out.marcaModelo) {
    m = raw.match(
      /([A-Z]{2,15})\s*\/\s*([A-Z0-9][A-Z0-9\s.\-]{2,40})/i
    );
    if (m && m[0].length < 60)
      out.marcaModelo = `${m[1].toUpperCase()}/${m[2].toUpperCase().trim()}`;
  }

  return out;
}

function mergeIntoVeiculo(existing, parsed) {
  /** @type {Record<string, [string, string]>} */
  const changes = {};
  const fieldMap = [
    ["marcaModelo", "marcaModelo"],
    ["anoModelo", "anoModelo"],
    ["chassi", "chassi"],
    ["renavam", "renavam"],
    ["cor", "cor"],
  ];
  for (const [jsonKey, srcKey] of fieldMap) {
    if (!parsed[srcKey]) continue;
    const newv = String(parsed[srcKey]).trim();
    if (!newv) continue;
    const oldv = String(existing[jsonKey] || "").trim();
    if (oldv !== newv) {
      existing[jsonKey] = newv;
      changes[jsonKey] = [oldv, newv];
    }
  }
  if (parsed.placa_doc) {
    const newp = formatPlacaHyphen(parsed.placa_doc);
    const oldp = String(existing.placa || "")
      .trim()
      .toUpperCase();
    if (compactPlaca(newp) !== compactPlaca(oldp)) {
      changes._placa_doc_diff = [oldp, newp];
    }
  }
  return changes;
}

function parseArgs() {
  const argv = process.argv.slice(2);
  let dryRun = false;
  let placa = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") dryRun = true;
    if (argv[i] === "--placa" && argv[i + 1]) {
      placa = argv[i + 1];
      i++;
    }
  }
  return { dryRun, placa };
}

async function main() {
  const { dryRun, placa: filtroRaw } = parseArgs();
  const filtro = filtroRaw ? compactPlaca(filtroRaw) : null;

  if (!fs.existsSync(DBV)) {
    console.error("Não encontrado:", DBV);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(DBV, "utf8"));
  const veiculos = data.veiculos || [];

  const roots = [];
  const dr = loadDocumentosRaiz();
  if (dr) roots.push(dr);
  if (fs.existsSync(VEIC_DIR)) roots.push(VEIC_DIR);

  if (!roots.length) {
    console.error("Nenhuma pasta (documentosRaiz ou veiculos/).");
    process.exit(1);
  }

  const index = collectCrlvIndex(roots);
  if (!Object.keys(index).length) {
    console.error("Nenhum PDF de CRLV indexado.");
    process.exit(1);
  }

  let totalChanges = 0;
  const notFound = [];

  for (const v of veiculos) {
    const placa = v.placa || "";
    const key = compactPlaca(placa);
    if (filtro && key !== filtro) continue;
    const pdf = index[key];
    if (!pdf) {
      notFound.push(placa);
      continue;
    }
    let text;
    try {
      text = await extractPdfText(pdf);
    } catch (e) {
      console.error(`[erro] ${placa} <- ${pdf}:`, e.message);
      continue;
    }
    const parsed = parseCrlv(text);
    if (!Object.keys(parsed).length) {
      console.error(`[aviso] ${placa}: nenhum campo extraído de ${path.basename(pdf)}`);
      continue;
    }
    const ch = mergeIntoVeiculo(v, parsed);
    if (Object.keys(ch).length) {
      totalChanges++;
      console.log(`${placa} <- ${pdf}`);
      for (const [k, [o, n]] of Object.entries(ch)) {
        console.log(`  ${k}: ${JSON.stringify(o)} -> ${JSON.stringify(n)}`);
      }
    }
  }

  if (notFound.length && !filtro) {
    console.log("\nSem PDF indexado para:", notFound.join(", "));
  } else if (notFound.length && filtro) {
    console.error("Sem PDF para placa", filtro);
    process.exit(1);
  }

  if (dryRun) {
    console.log("\n[dry-run] não gravado (nenhuma alteração persistida).");
    return;
  }

  if (totalChanges) {
    data.atualizadoEm = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(DBV, JSON.stringify(data, null, 2) + "\n", "utf8");
    console.log(`\nGravado: ${DBV} (${totalChanges} veículo(s) alterados)`);
  } else {
    console.log("Nenhuma alteração aplicada.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
