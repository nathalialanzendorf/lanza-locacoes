import fs from "node:fs";
import path from "node:path";

import { loadParceiroDespesasDb } from "../lib/parceiroDespesasDb.js";
import { rastreadorValorFixo } from "../lib/rastreadorFixo.js";
import { prestacaoContasBaseDir } from "../lib/lanzaPaths.js";
import { REPO_ROOT } from "../lib/repoRoot.js";
import { RELATORIOS_TMP_DIR } from "../lib/relatoriosPaths.js";

const DB = path.join(REPO_ROOT, "database");

const SEM_SEGURO = new Set(["luiz paulo", "jhonny", "baiano"]);

function load(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(DB, name), "utf8"));
}

function brl(v: number): string {
  return Number(v).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function norm(p: string): string {
  return String(p || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function modeloCurto(mm: string): string {
  if (!mm) return "";
  const last = mm.split("/").pop() || "";
  return last.split(/\s+/)[0] || "";
}

function anoCurto(am: string): string {
  if (!am) return "";
  const parts = am.split("/");
  return parts[parts.length - 1] || "";
}

/** DD/MM/AAAA -> AAAAMMDD; MM/AAAA -> AAAAMM01; senão 0 (data sortável/comparável). */
function dataToNum(d: string): number {
  const full = String(d ?? "").trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (full) return Number(`${full[3]}${full[2]}${full[1]}`);
  const comp = String(d ?? "").trim().match(/^(\d{2})\/(\d{4})/);
  if (comp) return Number(`${comp[2]}${comp[1]}01`);
  return 0;
}

function temBaixa(d: Record<string, unknown>): boolean {
  return Boolean(String((d as { baixa?: unknown }).baixa ?? "").trim());
}

/** Categorias que reaparecem como lembrete enquanto vencidas e sem baixa. */
const PENDENCIA_CATS = new Set(["ipva", "licenciamento"]);

type Inp = {
  competencia: string;
  competenciasDespesas?: string[];
  periodo?: { inicio?: string; fim?: string };
  rotulo?: string;
  rastreadorValor?: number;
  rastreadorDia?: number;
  veiculos: Record<string, unknown>[];
};

export function main(argv: string[]): void {
  const inpPath = path.resolve(argv[0]!);
  const inp = JSON.parse(fs.readFileSync(inpPath, "utf8")) as Inp;
  const comp = inp.competencia;
  const [mmComp, aaaaComp] = comp.split("/");
  const pastaComp = `${mmComp}.${aaaaComp}`;

  const compsDesp = inp.competenciasDespesas ?? [comp];
  const periodo = inp.periodo ?? {};
  const rotulo = inp.rotulo;
  // Início do período: limite para considerar um débito "já vencido" (lembrete).
  const periodoInicioNum = dataToNum(periodo.inicio ?? `01/${mmComp}/${aaaaComp}`);

  const rastValor = Number(inp.rastreadorValor ?? rastreadorValorFixo(comp));
  const rastDia = Number(inp.rastreadorDia ?? 10);

  const despesas = loadParceiroDespesasDb().parceiroDespesas as Record<string, unknown>[];
  const veiculosArr = (load("veiculos.json") as { veiculos: Record<string, unknown>[] })
    .veiculos;
  const veiculos = new Map(
    veiculosArr.map((v) => [norm(String(v.placa)), v] as const),
  );
  const parceiros = Object.fromEntries(
    (load("parceiros.json") as { parceiros: { id: string; nome: string }[] }).parceiros.map(
      (p) => [p.id, p] as const,
    ),
  );
  const donoId = Object.fromEntries(
    (
      load("parceiro-veiculo.json") as {
        vinculos: { veiculoId: string; parceiroId: string }[];
      }
    ).vinculos.map((l) => [l.veiculoId, l.parceiroId] as const),
  );

  function donoNome(vid: string): string {
    const pid = donoId[vid];
    return pid ? parceiros[pid]?.nome ?? "?" : "?";
  }

  const porParceiro = new Map<string, [Record<string, unknown>, Record<string, unknown>][]>();
  const avisosGlobais: string[] = [];

  for (const item of inp.veiculos) {
    const placa = String((item as { placa: string }).placa);
    const v = veiculos.get(norm(placa));
    if (!v) {
      avisosGlobais.push(`Veículo ${placa} não cadastrado — pulado.`);
      continue;
    }
    const parceiro = donoNome(String(v.id));
    const list = porParceiro.get(parceiro) ?? [];
    list.push([item, v]);
    porParceiro.set(parceiro, list);
  }

  const outDir = path.join(prestacaoContasBaseDir(), pastaComp);
  fs.mkdirSync(outDir, { recursive: true });
  const arquivosGerados: [string, string][] = [];

  // Acumulador de dados estruturados (sidecar JSON) — alimenta o canvas.
  type GastoDados = { data: string; categoria: string; descricao: string; valor: number };
  type VeiculoDados = {
    placa: string;
    modelo: string;
    ano: string;
    particular: boolean;
    gastos: GastoDados[];
    subtotalGastos: number;
    ganho: { valor: number; descricao: string };
    devidoMesAnterior: number;
    descontoManutencao: { valor: number; descricao: string };
    totalDescontos: number;
    total: number;
    pendencias: GastoDados[];
    totalPendencias: number;
  };
  type ParceiroDados = {
    parceiro: string;
    arquivoTxt: string;
    veiculos: VeiculoDados[];
    consolidado: { totalDescontos: number; totalGanhos: number; totalLiquido: number };
    avisos: string[];
  };
  const dadosParceiros: ParceiroDados[] = [];

  for (const [parceiro, itens] of porParceiro) {
    const linhas: string[] = [];
    let tg = 0;
    let tga = 0;
    let tt = 0;
    const avisosParc: string[] = [];
    const veiculosDados: VeiculoDados[] = [];
    const temSeguro = !SEM_SEGURO.has(parceiro.toLowerCase().trim());

    for (const [item, v] of itens) {
      const vid = String(v.id);
      const vPlaca = String(v.placa);
      let gastos = despesas
        .filter(
          (d) =>
            compsDesp.includes(String(d.competencia)) &&
            norm(String(d.placa ?? "")) === norm(vPlaca),
        )
        .map((d) => ({ ...d }));

      if (
        temSeguro &&
        !gastos.some((d) => String(d.categoria ?? "").toLowerCase() === "seguro")
      ) {
        avisosParc.push(`  ⚠️ ${vPlaca}: SEGURO de ${comp} não importado.`);
      }

      const particular = (v as { particular?: boolean }).particular === true;
      if (
        !particular &&
        !gastos.some((d) => String(d.categoria ?? "").toLowerCase() === "rastreador")
      ) {
        gastos.push({
          data: `${String(rastDia).padStart(2, "0")}/${mmComp}/${aaaaComp}`,
          categoria: "Rastreador",
          descricao: "Rastreador",
          valor: rastValor,
        });
      }

      gastos.sort((a, b) => String(a.data ?? "").localeCompare(String(b.data ?? "")));
      const soma = gastos.reduce((s, d) => s + Number(d.valor), 0);
      const ganho = (item as { ganho?: { valor?: number; descricao?: string } }).ganho ?? {};
      const gval = Number(ganho.valor ?? 0) || 0;
      const devido = Number((item as { devidoMesAnterior?: number }).devidoMesAnterior ?? 0) || 0;
      const desc =
        (item as { descontoManutencao?: { valor?: number; descricao?: string } })
          .descontoManutencao ?? {};
      const dval = Number(desc.valor ?? 0) || 0;
      const totalDescontos = soma + devido + dval;
      const total = gval - totalDescontos;

      const modelo = modeloCurto(String(v.marcaModelo ?? ""));
      const ano = anoCurto(String(v.anoModelo ?? ""));
      const L: string[] = [
        `🚗 *${vPlaca} — ${modelo} ${ano}* (${parceiro})`,
        "",
        "📋 *Gastos*",
      ];
      for (const d of gastos) {
        L.push(`• ${d.data} — ${d.descricao} — R$ ${brl(Number(d.valor))}`);
      }
      L.push(`💰 Subtotal gastos: R$ ${brl(soma)}`, "");
      L.push(
        `💵 Ganho: R$ ${brl(gval)}` +
          (ganho.descricao ? ` (${ganho.descricao})` : ""),
      );
      L.push(`➖ Desconto mês anterior: R$ ${brl(devido)}`);
      let dm = `🔧 Desconto manutenção: R$ ${brl(dval)}`;
      if (desc.descricao) dm += ` (${desc.descricao})`;
      L.push(dm);
      L.push(`➖ Total descontos: R$ ${brl(totalDescontos)}`);
      L.push("", `✅ *TOTAL: R$ ${brl(total)}*`);

      // Lembrete: IPVA/Licenciamento já vencidos (compet. anterior) e ainda sem
      // baixa. Apenas informativo — NÃO entra no total (o saldo real flui por
      // "Devido mês anterior").
      const pendBrutas = despesas
        .filter(
          (d) =>
            PENDENCIA_CATS.has(String(d.categoria ?? "").toLowerCase()) &&
            norm(String(d.placa ?? "")) === norm(vPlaca) &&
            !compsDesp.includes(String(d.competencia)) &&
            !temBaixa(d) &&
            dataToNum(String(d.data ?? "")) > 0 &&
            dataToNum(String(d.data ?? "")) < periodoInicioNum,
        )
        .sort((a, b) => dataToNum(String(a.data ?? "")) - dataToNum(String(b.data ?? "")));

      // Dedupe IPVA: cota única e parcelas são a MESMA dívida. Se houver cota
      // única no ano, descartar as parcelas daquele ano (evita lembrete/total
      // em duplicidade).
      const ipvaAno = (d: Record<string, unknown>): string =>
        String(d.descricao ?? "").match(/(\d{4})/)?.[1] ??
        anoCurto(String(d.competencia ?? ""));
      const ehCotaUnica = (d: Record<string, unknown>): boolean =>
        /cota\s*[uú]nica/i.test(String(d.descricao ?? ""));
      const ehIpva = (d: Record<string, unknown>): boolean =>
        String(d.categoria ?? "").toLowerCase() === "ipva";
      const anosComCotaUnica = new Set(
        pendBrutas.filter((d) => ehIpva(d) && ehCotaUnica(d)).map(ipvaAno),
      );
      const pendencias = pendBrutas.filter(
        (d) => !(ehIpva(d) && !ehCotaUnica(d) && anosComCotaUnica.has(ipvaAno(d))),
      );

      if (pendencias.length) {
        const somaPend = pendencias.reduce((s, d) => s + Number(d.valor), 0);
        L.push("", "⚠️ *Pendências vencidas (lembrete — ainda sem baixa)*");
        for (const d of pendencias) {
          L.push(
            `• ${d.data} — ${d.descricao} — R$ ${brl(Number(d.valor))} (venc. ${d.competencia})`,
          );
        }
        L.push(`🔔 Total pendente (não somado): R$ ${brl(somaPend)}`);
      }

      linhas.push(L.join("\n"));

      const totalPendencias = pendencias.reduce((s, d) => s + Number(d.valor), 0);
      veiculosDados.push({
        placa: vPlaca,
        modelo,
        ano,
        particular,
        gastos: gastos.map((d) => ({
          data: String(d.data ?? ""),
          categoria: String(d.categoria ?? ""),
          descricao: String(d.descricao ?? ""),
          valor: Number(d.valor) || 0,
        })),
        subtotalGastos: soma,
        ganho: { valor: gval, descricao: String(ganho.descricao ?? "") },
        devidoMesAnterior: devido,
        descontoManutencao: { valor: dval, descricao: String(desc.descricao ?? "") },
        totalDescontos,
        total,
        pendencias: pendencias.map((d) => ({
          data: String(d.data ?? ""),
          categoria: String(d.categoria ?? ""),
          descricao: String(d.descricao ?? ""),
          valor: Number(d.valor) || 0,
        })),
        totalPendencias,
      });

      tg += totalDescontos;
      tga += gval;
      tt += total;
    }

    linhas.push(
      `━━━━━━━━━━━━━━━━━━━━\n` +
        `📊 *CONSOLIDADO ${parceiro.toUpperCase()} — ${comp}*\n` +
        `➖ Total descontos: R$ ${brl(tg)}\n` +
        `💵 Total ganhos: R$ ${brl(tga)}\n` +
        `✅ *Total líquido: R$ ${brl(tt)}*`,
    );

    const cab: string[] = [];
    const periodoTxt =
      periodo.inicio && periodo.fim
        ? `🗓️ Competência: ${periodo.inicio} a ${periodo.fim}`
        : "";
    const titulo = rotulo ?? (periodoTxt ? "Relatório de prestação de contas" : "");
    if (titulo) cab.push(`📄 *${titulo}*`);
    if (periodoTxt) cab.push(periodoTxt);
    const corpo = linhas.join("\n\n\n");
    const texto = (cab.length ? cab.join("\n") + "\n\n\n" : "") + corpo + "\n";
    const saida = path.join(outDir, `${parceiro}.txt`);
    fs.writeFileSync(saida, texto, "utf8");
    arquivosGerados.push([parceiro, saida]);
    dadosParceiros.push({
      parceiro,
      arquivoTxt: saida,
      veiculos: veiculosDados,
      consolidado: { totalDescontos: tg, totalGanhos: tga, totalLiquido: tt },
      avisos: avisosParc.map((a) => a.trim()),
    });
    console.log(texto);
    if (avisosParc.length) {
      for (const a of avisosParc) console.log(a);
    }
  }

  console.log(`\n[arquivos gerados em ${outDir}]`);
  for (const [p, s] of arquivosGerados) {
    console.log(`  ${p}: ${s}`);
  }
  for (const a of avisosGlobais) console.log(a);

  // JSON de dados estruturados (sidecar) — alimenta o canvas. Gravado no repo
  // (relatorios/_tmp), não na pasta compartilhada de prestação de contas.
  fs.mkdirSync(RELATORIOS_TMP_DIR, { recursive: true });
  const dadosPath = path.join(RELATORIOS_TMP_DIR, `prestacao-${mmComp}-${aaaaComp}.json`);
  fs.writeFileSync(
    dadosPath,
    JSON.stringify(
      {
        competencia: comp,
        rotulo: rotulo ?? null,
        periodo,
        rastreadorValor: rastValor,
        rastreadorDia: rastDia,
        geradoEm: new Date().toISOString(),
        parceiros: dadosParceiros,
        avisos: avisosGlobais,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`\n[dados p/ canvas]\n  ${dadosPath}`);
}
