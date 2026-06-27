/**
 * Rastreador mensal fixo por veículo cadastrado.
 * R$ 50,00 — dia 10 da competência. Lançamento em lote idempotente (placa + competência).
 * Faz parte da skill cadastro-despesa (não é um sync — só grava localmente).
 */
import fs from "node:fs";
import crypto from "node:crypto";

import {
  loadParceiroDespesasDb,
  saveParceiroDespesasDb,
  type ParceiroDespesaRegistro,
} from "./parceiroDespesasDb.js";
import { compactPlaca, formatPlacaHyphen } from "./placa.js";
import { DB_VEICULOS } from "./parceiroDespesasDb.js";

export const RASTREADOR_DIA_PADRAO = 10;
export const RASTREADOR_VALOR_PADRAO = 50;

/** @deprecated use RASTREADOR_VALOR_PADRAO */
export const RASTREADOR_VALOR_ANTES_MAIO = 40;
/** @deprecated use RASTREADOR_VALOR_PADRAO */
export const RASTREADOR_VALOR_MAIO_EM_DIANTE = 50;

export function rastreadorValorFixo(_competencia?: string): number {
  return RASTREADOR_VALOR_PADRAO;
}

export function rastreadorDataFixa(competencia: string, dia = RASTREADOR_DIA_PADRAO): string {
  const [mm, aaaa] = competencia.split("/");
  return `${String(dia).padStart(2, "0")}/${mm}/${aaaa}`;
}

export function origemRastreadorFixo(placa: string, competencia: string): string {
  return `rastreador-fixo/${compactPlaca(placa)}/${competencia.replace("/", "-")}`;
}

export function listCompetenciasMensais(desde: string, ate: string): string[] {
  const [mm0, aa0] = desde.split("/").map(Number);
  const [mm1, aa1] = ate.split("/").map(Number);
  const out: string[] = [];
  let y = aa0!;
  let m = mm0!;
  while (y < aa1! || (y === aa1 && m <= mm1!)) {
    out.push(`${String(m).padStart(2, "0")}/${y}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export function competenciaAtual(): string {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`;
}

type LancarRastreadorOpts = {
  desde?: string;
  ate?: string;
  dryRun?: boolean;
};

export type LancarRastreadorResult = {
  novos: number;
  atualizados: number;
  semAlteracao: number;
  duplicatasRemovidas: number;
  competencias: string[];
  veiculos: number;
};

function loadVeiculos(): { id: string; placa: string }[] {
  const raw = JSON.parse(fs.readFileSync(DB_VEICULOS, "utf8")) as {
    veiculos: { id: string; placa: string; ativo?: boolean; particular?: boolean }[];
  };
  // Taxa só para veículos ATIVOS e de LOCAÇÃO (particular do proprietário não paga rastreador).
  return raw.veiculos.filter((v) => v.ativo !== false && v.particular !== true);
}

function findRastreadoresMes(
  despesas: ParceiroDespesaRegistro[],
  placa: string,
  competencia: string,
): ParceiroDespesaRegistro[] {
  const key = compactPlaca(placa);
  return despesas.filter(
    (d) =>
      String(d.categoria).toLowerCase() === "rastreador" &&
      d.competencia === competencia &&
      compactPlaca(d.placa) === key,
  );
}

function pickCanonicRastreador(
  matches: ParceiroDespesaRegistro[],
  origem: string,
): ParceiroDespesaRegistro | undefined {
  if (!matches.length) return undefined;
  return (
    matches.find((d) => d.origem === origem) ??
    matches.find((d) => d.origem.startsWith("rastreador-fixo/")) ??
    matches[0]
  );
}

export function lancarRastreadorFixo(opts: LancarRastreadorOpts = {}): LancarRastreadorResult {
  const desde = opts.desde ?? "01/2026";
  const ate = opts.ate ?? competenciaAtual();
  const competencias = listCompetenciasMensais(desde, ate);
  const veiculos = loadVeiculos();
  const db = loadParceiroDespesasDb();

  let novos = 0;
  let atualizados = 0;
  let semAlteracao = 0;
  let duplicatasRemovidas = 0;

  for (const v of veiculos) {
    for (const comp of competencias) {
      const valor = rastreadorValorFixo(comp);
      const data = rastreadorDataFixa(comp);
      const origem = origemRastreadorFixo(v.placa, comp);
      const matches = findRastreadoresMes(db.parceiroDespesas, v.placa, comp);
      const ex = pickCanonicRastreador(matches, origem);

      const extras = matches.filter((d) => d !== ex);
      if (extras.length && !opts.dryRun) {
        const removeIds = new Set(extras.map((d) => d.id));
        db.parceiroDespesas = db.parceiroDespesas.filter((d) => !removeIds.has(d.id));
        duplicatasRemovidas += extras.length;
      } else if (extras.length) {
        duplicatasRemovidas += extras.length;
      }

      if (!ex) {
        if (!opts.dryRun) {
          db.parceiroDespesas.push({
            id: crypto.randomUUID(),
            veiculoId: v.id,
            placa: formatPlacaHyphen(v.placa),
            categoria: "Rastreador",
            descricao: "Rastreador",
            data,
            valor,
            competencia: comp,
            origem,
          });
        }
        novos++;
        continue;
      }

      const changed =
        ex.valor !== valor ||
        ex.data !== data ||
        ex.descricao !== "Rastreador" ||
        ex.veiculoId !== v.id ||
        ex.origem !== origem;

      if (changed) {
        if (!opts.dryRun) {
          ex.valor = valor;
          ex.data = data;
          ex.descricao = "Rastreador";
          ex.placa = formatPlacaHyphen(v.placa);
          ex.veiculoId = v.id;
          ex.origem = origem;
        }
        atualizados++;
      } else {
        semAlteracao++;
      }
    }
  }

  if (!opts.dryRun && (novos > 0 || atualizados > 0 || duplicatasRemovidas > 0)) {
    saveParceiroDespesasDb(db);
  }

  return {
    novos,
    atualizados,
    semAlteracao,
    duplicatasRemovidas,
    competencias,
    veiculos: veiculos.length,
  };
}
