/**
 * Gera cobranças em lote por tipo (somente alvos elegíveis em aberto).
 */
import fs from "node:fs";
import path from "node:path";

import {
  gerarEstacionamento,
  gerarManutencao,
  gerarMultas,
  gerarPedagio,
  gerarRenegociacao,
  gerarSemanal,
  salvarCobranca,
  COBRANCAS_OUT_DIR,
  type ResultadoCobranca,
  type TipoCobranca,
} from "./cobrancas.js";
import {
  listarAlvosCobranca,
  type AlvoCobranca,
  type FiltroAlvosCobranca,
  type TipoCobrancaAction,
} from "./cobrancasAlvos.js";
import { loadContratosDb } from "./contratosDb.js";
import type { ClienteDespesaRegistro } from "./clienteDespesasDb.js";
import {
  calcularCobrancaSemanalAtraso,
  formatCobrancaSemanalAtrasoMarkdown,
} from "./pagamentoSemanalCobranca.js";
import { compactPlaca } from "./placa.js";

export type LoteCobrancaItem = {
  alvo: AlvoCobranca;
  resultados: ResultadoCobranca[];
  semanalAtraso?: {
    markdown: string;
    payload: Record<string, unknown>;
    totalGeral: number;
  };
  arquivos: string[];
  aviso?: string;
};

export type LoteCobrancaResult = {
  tipo: TipoCobrancaAction;
  items: LoteCobrancaItem[];
  resumo: { alvos: number; mensagens: number; ignorados: number };
};

function hojeBr(): string {
  const n = new Date();
  return `${String(n.getDate()).padStart(2, "0")}/${String(n.getMonth() + 1).padStart(2, "0")}/${n.getFullYear()}`;
}

function dataArquivo(): string {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getFullYear()}`;
}

function slug(s: string): string {
  return String(s || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function contratoAtivoPlaca(placa: string) {
  const p = compactPlaca(placa);
  const list = loadContratosDb().contratos.filter(
    (c) => c.status === "ativo" && compactPlaca(c.placa ?? "") === p,
  );
  list.sort((a, b) => (b.versao ?? 0) - (a.versao ?? 0));
  return list[0] ?? null;
}

function somaValorDespesas(despesas: ClienteDespesaRegistro[]): number {
  return despesas.reduce((s, d) => s + (Number(d.valorMulta) || 0), 0);
}

function tipoCobrancaWhatsApp(tipo: TipoCobrancaAction): TipoCobranca {
  const map: Record<TipoCobrancaAction, TipoCobranca> = {
    "pagamento-semanal": "semanal",
    renegociacao: "renegociacao",
    infracoes: "multa",
    pedagio: "pedagio",
    "estacionamento-rotativo": "estacionamento",
    manutencao: "manutencao",
  };
  return map[tipo];
}

function gerarWhatsAppAlvo(
  alvo: AlvoCobranca,
  opts?: { dia?: number; nome?: string },
): ResultadoCobranca[] {
  const nome = opts?.nome ?? alvo.clienteNome ?? undefined;
  switch (alvo.tipo) {
    case "pagamento-semanal":
      return [gerarSemanal(alvo.placa, opts?.dia ?? 3, { nome })];
    case "renegociacao":
      return [
        gerarRenegociacao(alvo.placa, somaValorDespesas(alvo.despesas), { nome }),
      ];
    case "infracoes":
      return gerarMultas(alvo.placa, { nome });
    case "pedagio":
      return [gerarPedagio(alvo.placa, { nome })];
    case "estacionamento-rotativo":
      return [gerarEstacionamento(alvo.placa, { nome })];
    case "manutencao":
      return [
        gerarManutencao(alvo.placa, somaValorDespesas(alvo.despesas), { nome }),
      ];
  }
}

function buildSemanalAtrasoAlvo(
  alvo: AlvoCobranca,
  dataPagamentoBr: string,
): { markdown: string; payload: Record<string, unknown>; totalGeral: number } | null {
  const contrato = contratoAtivoPlaca(alvo.placa);
  const valorSemanal = contrato?.valorSemanal ?? null;
  const valorDiaria = contrato?.valorDiaria ?? null;
  const vencimentos = alvo.vencimentosBr ?? [];

  if (valorSemanal == null || valorDiaria == null || vencimentos.length === 0) {
    return null;
  }

  const input = {
    valorSemanal,
    valorDiaria,
    vencimentosBr: vencimentos,
    dataPagamentoBr,
  };
  const resultado = calcularCobrancaSemanalAtraso(input);
  const payload: Record<string, unknown> = {
    ...input,
    tipo: "pagamento-semanal",
    cliente: {
      id: alvo.clienteId,
      nome: alvo.clienteNome,
    },
    placa: alvo.placa,
    ...resultado,
  };

  return {
    markdown: formatCobrancaSemanalAtrasoMarkdown(
      {
        ...input,
        clienteNome: alvo.clienteNome ?? undefined,
        placa: alvo.placa,
      },
      resultado,
    ),
    payload,
    totalGeral: resultado.totalGeral,
  };
}

/** Lista alvos sem gerar arquivos. */
export function listarResumoAlvos(
  tipo: TipoCobrancaAction,
  filtro?: FiltroAlvosCobranca,
): AlvoCobranca[] {
  return listarAlvosCobranca(tipo, filtro);
}

/** Gera cobranças para todos os alvos elegíveis do tipo. */
export function executarLoteCobranca(
  tipo: TipoCobrancaAction,
  opts?: {
    filtro?: FiltroAlvosCobranca;
    dia?: number;
    dataPagamentoBr?: string;
    salvar?: boolean;
    outDir?: string;
  },
): LoteCobrancaResult {
  const alvos = listarAlvosCobranca(tipo, opts?.filtro);
  const salvar = opts?.salvar !== false;
  const outDir = opts?.outDir ?? COBRANCAS_OUT_DIR;
  const dataPagamentoBr = opts?.dataPagamentoBr ?? hojeBr();
  const items: LoteCobrancaItem[] = [];
  let mensagens = 0;
  let ignorados = 0;

  for (const alvo of alvos) {
    const item: LoteCobrancaItem = {
      alvo,
      resultados: [],
      arquivos: [],
    };

    if (tipo === "pagamento-semanal") {
      const semanal = buildSemanalAtrasoAlvo(alvo, dataPagamentoBr);
      if (!semanal) {
        item.aviso =
          "Contrato ativo ou valores semanal/diária não encontrados — sem tabela de atraso.";
        ignorados++;
      } else {
        item.semanalAtraso = semanal;
      }
    }

    try {
      item.resultados = gerarWhatsAppAlvo(alvo, { dia: opts?.dia });
      mensagens += item.resultados.length;
    } catch (e) {
      item.aviso = e instanceof Error ? e.message : String(e);
      ignorados++;
      items.push(item);
      continue;
    }

    if (salvar) {
      fs.mkdirSync(outDir, { recursive: true });
      for (const r of item.resultados) {
        item.arquivos.push(salvarCobranca(r, outDir));
      }

      if (item.semanalAtraso) {
        const slugNome = slug(alvo.clienteNome ?? alvo.placa);
        const dataArq = dataPagamentoBr.replace(/\//g, "-");
        const mdPath = path.join(
          outDir,
          `semanal-atraso-${slugNome}-${dataArq}.md`,
        );
        const jsonPath = path.join(
          outDir,
          `dados-semanal-atraso-${slugNome}-${dataArq}.json`,
        );
        fs.writeFileSync(mdPath, item.semanalAtraso.markdown, "utf8");
        fs.writeFileSync(
          jsonPath,
          JSON.stringify(item.semanalAtraso.payload, null, 2),
          "utf8",
        );
        item.arquivos.push(mdPath, jsonPath);
      }
    }

    items.push(item);
  }

  return {
    tipo,
    items,
    resumo: { alvos: alvos.length, mensagens, ignorados },
  };
}

export function salvarLoteConsolidado(
  result: LoteCobrancaResult,
  outDir?: string,
): string {
  const dir = outDir ?? COBRANCAS_OUT_DIR;
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    tipo: result.tipo,
    tipoWhatsApp: tipoCobrancaWhatsApp(result.tipo),
    geradoEm: new Date().toISOString(),
    resumo: result.resumo,
    alvos: result.items.map((item) => ({
      placa: item.alvo.placa,
      clienteId: item.alvo.clienteId,
      clienteNome: item.alvo.clienteNome,
      despesas: item.alvo.despesas.length,
      aviso: item.aviso ?? null,
      totalGeralSemanal: item.semanalAtraso?.totalGeral ?? null,
      arquivos: item.arquivos,
      cobrancas: item.resultados.map((r) => ({
        titulo: r.titulo,
        nomeArquivo: r.nomeArquivo,
        texto: r.texto,
        ...r.dados,
      })),
    })),
  };
  const saida = path.join(
    dir,
    `dados-lote-${result.tipo}-${dataArquivo()}.json`,
  );
  fs.writeFileSync(saida, JSON.stringify(payload, null, 2), "utf8");
  return saida;
}
