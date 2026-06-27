/**
 * Atualiza `database/veiculos.json`: fipe, fipeCodigo, fipeModelo, fipeValor, fipeReferencia.
 * Lógica de consulta/resolução fica na tool `src/lib/fipe`.
 */
import fs from "node:fs";
import path from "node:path";
import {
  listarMarcas,
  resolverFipeVeiculo,
  type VeiculoFipeInput,
} from "../lib/fipe/index.js";
import { REPO_ROOT } from "../lib/repoRoot.js";

const DB = path.join(REPO_ROOT, "database", "veiculos.json");

function parseArgs(argv: string[]): { placaFilter: string | null } {
  let placaFilter: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--placa" && argv[i + 1]) {
      placaFilter = argv[i + 1]!;
      i++;
    }
  }
  return { placaFilter };
}

function normPlaca(s: string): string {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

type Veiculo = VeiculoFipeInput & { observacao?: string; particular?: boolean };
type VeiculosDb = { veiculos: Veiculo[]; atualizadoEm?: string };

async function runFipeSyncCore(
  placaFilter: string | null,
): Promise<{ errors: { placa: string; erro: string }[]; notFound?: string }> {
  const raw = fs.readFileSync(DB, "utf8");
  const data = JSON.parse(raw) as VeiculosDb;
  const brands = await listarMarcas();
  const errors: { placa: string; erro: string }[] = [];

  // Com --placa: respeita o pedido explícito (mesmo inativo). Sem --placa
  // (frota inteira): pula inativos — não fazemos consulta externa para eles
  // (ver regra "Veículos inativos" em .cursor/rules/lanza-tools.mdc).
  const lista = placaFilter
    ? data.veiculos.filter((v) => normPlaca(v.placa) === normPlaca(placaFilter))
    : data.veiculos.filter((v) => v.ativo !== false);

  if (placaFilter && lista.length === 0) {
    return { errors: [], notFound: placaFilter };
  }

  for (const v of lista) {
    try {
      const upd = await resolverFipeVeiculo(v, brands);
      Object.assign(v, upd);
      if (v.placa === "RAH-4F54" && v.observacao && /fipe/i.test(String(v.observacao))) {
        delete v.observacao;
      }
      console.log("OK", v.placa, "->", upd.fipeCodigo, upd.fipeModelo);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("ERRO", v.placa, msg);
      errors.push({ placa: v.placa, erro: msg });
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  data.atualizadoEm = today;
  fs.writeFileSync(DB, JSON.stringify(data, null, 2) + "\n", "utf8");

  if (errors.length) {
    console.error("\nFalhas:", JSON.stringify(errors, null, 2));
  }
  return { errors };
}

/** Chamado após cadastrar veículo — não encerra o processo em falha FIPE. */
export async function syncFipeNovoVeiculo(placa: string): Promise<void> {
  if (!placa?.trim()) return;
  const r = await runFipeSyncCore(placa.trim());
  if (r.notFound) {
    console.error("[aviso] Placa nao encontrada em veiculos.json:", r.notFound);
    return;
  }
  if (r.errors.length) {
    console.error("[aviso] FIPE sync com falhas (veja acima)");
  } else {
    console.log("[fipe] campos FIPE atualizados na API");
  }
}

export async function main(argv: string[]): Promise<void> {
  const { placaFilter } = parseArgs(argv);
  const r = await runFipeSyncCore(placaFilter);
  if (r.notFound) {
    console.error("Placa nao encontrada em veiculos.json:", r.notFound);
    process.exit(1);
  }
  if (r.errors.length) process.exitCode = 1;
}
