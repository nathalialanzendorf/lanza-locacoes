import fs from "node:fs";
import path from "node:path";

import {
  addDays,
  daysBetween,
  extrairContrato,
  fmtDataBr,
  intervaloPagamentoDias,
  parseDataBr,
  startOfDay,
  valorDiariaContrato,
  valorParcelaContrato,
  type ContratoExtraido,
} from "./contratoExtrair.js";
import {
  isClienteDespesaAtiva,
  isInfracaoTransito,
  loadClienteDespesasDb,
  type ClienteDespesaRegistro,
} from "./clienteDespesasDb.js";
import { validarContratoVigenteParaEncerramento } from "./contratosDb.js";
import { compactPlaca } from "./placa.js";
import { REPO_ROOT } from "./repoRoot.js";
import { findVeiculoByPlaca } from "./veiculosDb.js";

export type EncerramentoInput = {
  pastaContrato: string;
  dataEncerramento: string;
  semanasPagas?: string[];
  infracoesPagasAuto?: string[];
  /** @deprecated use infracoesPagasAuto */
  multasPagasAuto?: string[];
  incluirTodasInfracoesPlaca?: boolean;
  /** @deprecated use incluirTodasInfracoesPlaca */
  incluirTodasMultasPlaca?: boolean;
  diasPrimeiroVencimento?: number;
  condutorId?: string | null;
};

export type ParcelaAtrasada = {
  vencimento: string;
  valorSemanal: number;
};

export type DiariaAtraso = {
  vencimento: string;
  diasAtraso: number;
  valorDiaria: number;
  total: number;
};

export type EncerramentoResult = {
  contrato: ContratoExtraido;
  dataEncerramento: string;
  diasLocacao: number;
  diasRestantes: number;
  proporcaoRestante: number;
  infracoes: ClienteDespesaRegistro[];
  totalInfracoes: number;
  /** @deprecated use infracoes */
  multas?: ClienteDespesaRegistro[];
  /** @deprecated use totalInfracoes */
  totalMultas?: number;
  manutencoes: ClienteDespesaRegistro[];
  totalManutencoes: number;
  parcelasEmAberto: ParcelaAtrasada[];
  totalParcelasEmAberto: number;
  diariasAtraso: DiariaAtraso[];
  totalDiariasAtraso: number;
  retencaoCaucao: number;
  caucaoDevolver: number;
  totalDebitos: number;
  saldoFinal: number;
  avisos: string[];
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function brl(v: number): string {
  return Number(v).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function normVencimento(s: string): string {
  const d = parseDataBr(s);
  return d ? fmtDataBr(d) : s.trim();
}

function loadClienteId(cpf: string | null, condutorId?: string | null): string | null {
  if (condutorId) return condutorId;
  if (!cpf) return null;
  const p = path.join(REPO_ROOT, "database", "clientes.json");
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as {
      clientes?: { id?: string; cpf?: string }[];
    };
    const c = j.clientes?.find((x) => x.cpf === cpf);
    return c?.id ?? null;
  } catch {
    return null;
  }
}

function infracaoPaga(m: ClienteDespesaRegistro, pagasAuto: Set<string>): boolean {
  if (pagasAuto.has(m.autoInfracao.trim().toUpperCase())) return true;
  if (m.quitadaDetran === true) return true;
  return m.paga === true;
}

function despesaDoContrato(
  m: ClienteDespesaRegistro,
  contrato: ContratoExtraido,
  clienteId: string | null,
  incluirTodas: boolean,
): boolean {
  if (compactPlaca(m.veiculoId) !== compactPlaca(contrato.placa)) return false;
  if (incluirTodas) return true;
  if (clienteId && m.condutorId === clienteId) return true;
  if (m.condutorContrato) {
    const norm = (p: string) => path.normalize(p).toLowerCase();
    if (norm(m.condutorContrato) === norm(contrato.pastaContrato)) return true;
  }
  return false;
}

/** @deprecated alias */
function infracaoDoContrato(
  m: ClienteDespesaRegistro,
  contrato: ContratoExtraido,
  clienteId: string | null,
  incluirTodas: boolean,
): boolean {
  return despesaDoContrato(m, contrato, clienteId, incluirTodas);
}

function calcularVencimentos(
  inicio: Date,
  encerramento: Date,
  intervaloDias: number,
): Date[] {
  const out: Date[] = [];
  let due = addDays(startOfDay(inicio), intervaloDias);
  while (due.getTime() <= startOfDay(encerramento).getTime()) {
    out.push(new Date(due));
    due = addDays(due, intervaloDias);
  }
  return out;
}

export function calcularEncerramentoContrato(input: EncerramentoInput): EncerramentoResult {
  const contrato = extrairContrato(input.pastaContrato, { paraEncerramento: true });
  const veicReg = findVeiculoByPlaca(contrato.placa);
  if (veicReg?.particular === true) {
    throw new Error(
      `Veículo ${contrato.placa} é PARTICULAR (não-locação) — não há contrato/quebra de contrato.`,
    );
  }
  const registroVigente = validarContratoVigenteParaEncerramento(
    input.pastaContrato,
    contrato.placa,
    contrato.cpf,
    contrato.clienteNome,
  );
  const encerramento = parseDataBr(input.dataEncerramento);
  if (!encerramento) {
    throw new Error(`Data de encerramento inválida: ${input.dataEncerramento}`);
  }
  if (encerramento < startOfDay(contrato.inicio)) {
    throw new Error("Data de encerramento anterior ao início do contrato.");
  }

  const avisos: string[] = [];
  if (contrato.totalDocumentosContrato > 1) {
    const rotuloDoc =
      contrato.versaoDocumento > 0
        ? `v${contrato.versaoDocumento}`
        : path.basename(contrato.docx);
    avisos.push(
      `Renovação: ${contrato.totalDocumentosContrato} documentos na pasta; cálculo só com o mais recente (${rotuloDoc}). Versões anteriores ignoradas.`,
    );
  }
  if (registroVigente && (registroVigente.versao ?? 1) > 1) {
    avisos.push(
      `Contrato v${registroVigente.versao} (renovação); acerto referente só a este período, não a versões anteriores.`,
    );
  }
  if (registroVigente?.prazoDias != null && registroVigente.prazoDias > 0) {
    contrato.prazoDias = registroVigente.prazoDias;
  }
  const fimPrevistoDb = registroVigente?.dataFimPrevista
    ? parseDataBr(registroVigente.dataFimPrevista)
    : null;
  if (fimPrevistoDb) {
    contrato.fim = fimPrevistoDb;
  }
  const diasLocacao = daysBetween(contrato.inicio, encerramento);
  const diasRestantes = Math.max(0, contrato.prazoDias - diasLocacao);
  const proporcaoRestante = contrato.prazoDias > 0 ? diasRestantes / contrato.prazoDias : 0;
  const retencaoCaucao = round2(contrato.valorCaucao * proporcaoRestante);

  const pagasSet = new Set(
    (input.semanasPagas ?? [])
      .map(normVencimento)
      .filter((s) => {
        const d = parseDataBr(s);
        return d != null && d >= startOfDay(contrato.inicio);
      }),
  );
  const pagasAutoSet = new Set(
    (input.infracoesPagasAuto ?? input.multasPagasAuto ?? []).map((a) =>
      a.trim().toUpperCase(),
    ),
  );
  const incluirTodas =
    input.incluirTodasInfracoesPlaca === true || input.incluirTodasMultasPlaca === true;

  const intervalo = input.diasPrimeiroVencimento ?? intervaloPagamentoDias(contrato);
  const valorParcela = valorParcelaContrato(contrato);
  const valorDiaria = valorDiariaContrato(contrato);
  const vencimentos = calcularVencimentos(contrato.inicio, encerramento, intervalo);

  const parcelasEmAberto: ParcelaAtrasada[] = [];
  const diariasAtraso: DiariaAtraso[] = [];

  for (const due of vencimentos) {
    const vencStr = fmtDataBr(due);
    if (pagasSet.has(vencStr)) continue;

    parcelasEmAberto.push({
      vencimento: vencStr,
      valorSemanal: valorParcela,
    });

    const diasAtraso = daysBetween(due, encerramento);
    if (diasAtraso > 0) {
      diariasAtraso.push({
        vencimento: vencStr,
        diasAtraso,
        valorDiaria,
        total: round2(diasAtraso * valorDiaria),
      });
    }
  }

  const totalParcelasEmAberto = round2(
    parcelasEmAberto.reduce((s, p) => s + p.valorSemanal, 0),
  );
  const totalDiariasAtraso = round2(
    diariasAtraso.reduce((s, d) => s + d.total, 0),
  );

  const clienteId = loadClienteId(contrato.cpf, input.condutorId);
  const db = loadClienteDespesasDb();
  const infracoes = db.clienteDespesas.filter((m) => {
    if (!isClienteDespesaAtiva(m)) return false;
    if (!isInfracaoTransito(m)) return false;
    if (infracaoPaga(m, pagasAutoSet)) return false;
    if (!infracaoDoContrato(m, contrato, clienteId, incluirTodas)) {
      return false;
    }
    const da = parseDataBr(m.dataAutuacao);
    if (!da) return false;
    return da >= startOfDay(contrato.inicio) && da <= encerramento;
  });

  if (infracoes.some((m) => !m.condutorConfirmado)) {
    avisos.push(
      "Há infrações com condutor não confirmado — revisar antes de cobrar o locatário.",
    );
  }
  if (!clienteId && !incluirTodas) {
    avisos.push(
      "Cliente não encontrado em clientes.json; infrações filtradas só por pasta do contrato.",
    );
  }

  const totalInfracoes = round2(infracoes.reduce((s, m) => s + m.valorMulta, 0));

  const manutencoes = db.clienteDespesas.filter((m) => {
    if (!isClienteDespesaAtiva(m)) return false;
    if ((m.categoria ?? "") !== "Manutenção") return false;
    if (infracaoPaga(m, pagasAutoSet)) return false;
    if (!despesaDoContrato(m, contrato, clienteId, incluirTodas)) return false;
    const da = parseDataBr(m.dataAutuacao);
    if (!da) return false;
    return da >= startOfDay(contrato.inicio) && da <= encerramento;
  });
  if (manutencoes.some((m) => m.valorMulta <= 0)) {
    avisos.push(
      "Há manutenção com orçamento pendente (valor zero) — atualizar quando houver orçamento.",
    );
  }

  const totalManutencoes = round2(
    manutencoes.reduce((s, m) => s + (m.valorMulta > 0 ? m.valorMulta : 0), 0),
  );
  const totalDebitos = round2(
    totalInfracoes +
      totalManutencoes +
      totalParcelasEmAberto +
      totalDiariasAtraso +
      retencaoCaucao,
  );
  const caucaoDevolver = round2(Math.max(0, contrato.valorCaucao - retencaoCaucao));
  const saldoFinal = round2(contrato.valorCaucao - totalDebitos);

  return {
    contrato,
    dataEncerramento: fmtDataBr(encerramento),
    diasLocacao,
    diasRestantes,
    proporcaoRestante: round2(proporcaoRestante),
    infracoes,
    totalInfracoes,
    multas: infracoes,
    totalMultas: totalInfracoes,
    manutencoes,
    totalManutencoes,
    parcelasEmAberto,
    totalParcelasEmAberto,
    diariasAtraso,
    totalDiariasAtraso,
    retencaoCaucao,
    caucaoDevolver,
    totalDebitos,
    saldoFinal,
    avisos,
  };
}

export function formatarEncerramentoTexto(r: EncerramentoResult): string {
  const c = r.contrato;
  const pct = (r.proporcaoRestante * 100).toFixed(1).replace(".", ",");
  const lines: string[] = [
    "📄 *ENCERRAMENTO DE CONTRATO*",
    "",
    `👤 Cliente: ${c.clienteNome}`,
    `🚗 Placa: ${c.placa}`,
    `🗓️ Início: ${fmtDataBr(c.inicio)} → Fim previsto: ${fmtDataBr(c.fim)} (${c.prazoDias} dias)`,
    `🏁 Encerramento: ${r.dataEncerramento} (${r.diasLocacao} dias de locação)`,
    "",
    "💵 *Valores base*",
    `• Locação (${c.tipoContrato}): R$ ${brl(valorParcelaContrato(c))}`,
    `• Diária (atraso): R$ ${brl(valorDiariaContrato(c))}`,
    `• Caução: R$ ${brl(c.valorCaucao)}`,
    "",
    "🚦 *Infrações de trânsito (não pagas)*",
  ];

  if (r.infracoes.length === 0) {
    lines.push("• (nenhuma)");
  } else {
    for (const m of r.infracoes) {
      lines.push(
        `• ${m.autoInfracao} — ${m.dataAutuacao} — R$ ${brl(m.valorMulta)} — ${m.situacao}`,
      );
    }
  }
  lines.push(`💰 Subtotal infrações: R$ ${brl(r.totalInfracoes)}`);
  lines.push("");
  lines.push("🔧 *Manutenção / avarias (não pagas)*");
  if (r.manutencoes.length === 0) {
    lines.push("• (nenhuma)");
  } else {
    for (const m of r.manutencoes) {
      const valor =
        m.valorMulta > 0 ? `R$ ${brl(m.valorMulta)}` : "orçamento pendente";
      lines.push(`• ${m.descricao} — ${m.dataAutuacao} — ${valor} — ${m.situacao}`);
    }
  }
  lines.push(`💰 Subtotal manutenção: R$ ${brl(r.totalManutencoes)}`);
  lines.push("");
  lines.push("📅 *Locação semanal em aberto*");
  if (r.parcelasEmAberto.length === 0) {
    lines.push("• (nenhuma parcela em aberto)");
  } else {
    for (const p of r.parcelasEmAberto) {
      lines.push(`• Venc. ${p.vencimento}: R$ ${brl(p.valorSemanal)}`);
    }
  }
  lines.push(`💰 Subtotal parcelas: R$ ${brl(r.totalParcelasEmAberto)}`);
  lines.push("");
  lines.push("⏱️ *Diárias por atraso (após vencimento semanal)*");
  if (r.diariasAtraso.length === 0) {
    lines.push("• (nenhuma)");
  } else {
    for (const d of r.diariasAtraso) {
      lines.push(
        `• Venc. ${d.vencimento}: ${d.diasAtraso} dia(s) × R$ ${brl(d.valorDiaria)} = R$ ${brl(d.total)}`,
      );
    }
  }
  lines.push(`💰 Subtotal diárias: R$ ${brl(r.totalDiariasAtraso)}`);
  lines.push("");
  lines.push("📉 *Quebra de contrato (retenção caução)*");
  lines.push(`• Dias restantes: ${r.diasRestantes} / ${c.prazoDias} (${pct}%)`);
  lines.push(`• Retenção caução: R$ ${brl(r.retencaoCaucao)}`);
  lines.push(`• Caução a devolver (após retenção): R$ ${brl(r.caucaoDevolver)}`);
  lines.push("");
  lines.push("━━━━━━━━━━━━━━━━━━━━");
  lines.push("🧾 *Totais*");
  lines.push(`• Total débitos: R$ ${brl(r.totalDebitos)}`);
  lines.push(
    `${r.saldoFinal < 0 ? "🔴" : "✅"} *Saldo caução: R$ ${brl(r.saldoFinal)}* ${r.saldoFinal < 0 ? "(locatário deve complementar)" : "(a devolver ao locatário)"}`,
  );

  if (r.avisos.length) {
    lines.push("");
    lines.push("⚠️ *Avisos*");
    for (const a of r.avisos) lines.push(`• ${a}`);
  }

  return lines.join("\n");
}
