/**
 * Título e classificação de infrações de trânsito.
 *
 * Convenção Lanza (unificada com cadastro):
 * - `titulo` guarda o texto **cru do DETRAN** (ex.: "TRANSITAR EM VEL SUPERIOR…").
 * - `descricao` = `Pagamento infração {tipo} dd/mm/aaaa HH:mm` (sem ATRASADO).
 * - Legado aceito na leitura: `ATRASADO Multa {tipo} - {data}` / `Multa {tipo} - {data}`.
 */

import { CategoriaDespesaCliente } from "./domain/categoriaDespesaCliente.js";

function norm(s: string): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

/** Categoria é infração de trânsito? */
export function isCategoriaInfracao(categoria?: string): boolean {
  return norm(categoria ?? CategoriaDespesaCliente.Infracao).startsWith("infra");
}

/**
 * Deriva um tipo curto (velocidade, estacionamento, cinto…) do texto do DETRAN.
 * Fallback: "trânsito" quando não reconhecer.
 */
export function tipoInfracao(descricao: string): string {
  const t = norm(descricao);
  if (!t.trim()) return "trânsito";

  if (/excesso de vel|superior a (maxima|velocidade)|\bvelocidade\b|\bvel\b/.test(t)) return "velocidade";
  if (/estacion|estac\b/.test(t)) return "estacionamento";
  if (/local\/?horario proibido|parar em local|\bparada\b|\bparar\b/.test(t)) return "parada";
  if (/cinto/.test(t)) return "cinto";
  if (/luz baixa|farol|mant.* acesa|iluminac/.test(t)) return "farol";
  if (/celular|telefone|\bfone\b|seguran[dt]o.* telefone/.test(t)) return "celular";
  if (/sinal vermelho|avancar.* sinal|semaforo|parada obrigatoria|sinal de parada/.test(t)) return "sinal";
  if (/contramao|conversao|convers\b|retorno proibido|ultrapass/.test(t)) return "conversão";
  if (/acostamento/.test(t)) return "acostamento";
  if (/alcool|etilometro|bafometro|recusa.* teste|capacidade psicomotora/.test(t)) return "alcoolemia";
  if (/capacete/.test(t)) return "capacete";
  if (/rodizio/.test(t)) return "rodízio";
  if (/licenciamento|crlv|sem documento|porte.* documento/.test(t)) return "documento";
  if (/\bfaixa\b/.test(t)) return "faixa";
  return "trânsito";
}

/** Descrição canônica: `Pagamento infração {tipo} {dataAutuacao}`. `numeroAuto` não entra no texto. */
export function tituloInfracaoBase(
  descricao: string,
  dataAutuacao: string,
  _numeroAuto?: string,
): string {
  const tipo = tipoInfracao(descricao);
  const dt = String(dataAutuacao ?? "").trim();
  return dt ? `Pagamento infração ${tipo} ${dt}` : `Pagamento infração ${tipo}`;
}

/** Descrição padrão do registro (Gastos Gerais / grid) a partir do texto DETRAN. */
export function descricaoInfracaoCliente(
  textoDetran: string,
  dataAutuacao: string,
  numeroAuto?: string,
  _opts?: { emAberto?: boolean },
): string {
  return tituloInfracaoBase(textoDetran, dataAutuacao, numeroAuto);
}

/** Heurística: descrição já no padrão de cobrança (novo ou legado Multa). */
export function pareceDescricaoInfracaoCobranca(s: string): boolean {
  const t = String(s ?? "").trim();
  return (
    /^(atrasado\s+)?multa\b/i.test(t) ||
    /^(atrasado\s+)?pagamento\s+infra[cç][aã]o\b/i.test(t)
  );
}

/** @deprecated Use {@link pareceDescricaoInfracaoCobranca}. */
export function pareceTituloMulta(s: string): boolean {
  return pareceDescricaoInfracaoCobranca(s);
}

/** Cobrança legada no campo `titulo` e texto DETRAN em `descricao`. */
export function camposInfracaoInvertidos(titulo?: string | null, descricao?: string | null): boolean {
  const t = String(titulo ?? "").trim();
  const d = String(descricao ?? "").trim();
  if (!t || !d) return false;
  return pareceDescricaoInfracaoCobranca(t) && !pareceDescricaoInfracaoCobranca(d);
}

/**
 * Repara titulo (DETRAN) + descricao (cobrança) em registos legados ou invertidos.
 * Retorna null se já estiver coerente.
 */
export function repararCamposInfracaoCliente(args: {
  titulo?: string | null;
  descricao?: string | null;
  dataAutuacao?: string | null;
  numeroAuto?: string | null;
  /** Texto DETRAN vindo do sync (preferido). */
  textoDetranSync?: string | null;
}): { titulo: string; descricao: string; corrigiu: boolean } | null {
  const titulo = String(args.titulo ?? "").trim();
  const descricao = String(args.descricao ?? "").trim();
  const sync = String(args.textoDetranSync ?? "").trim();
  const data = String(args.dataAutuacao ?? "").trim();
  const auto = args.numeroAuto?.trim();

  const descricaoCobrancaLegada = pareceDescricaoInfracaoCobranca(descricao)
    ? descricao
    : pareceDescricaoInfracaoCobranca(titulo)
      ? titulo
      : null;

  if (sync && !pareceDescricaoInfracaoCobranca(sync)) {
    const invertido = camposInfracaoInvertidos(titulo, descricao);
    const campos = normalizarCamposInfracaoCliente({
      textoDetran: sync,
      dataAutuacao: data,
      numeroAuto: auto,
      descricaoRastreame: invertido ? null : descricaoCobrancaLegada,
    });
    if (titulo === campos.titulo && descricao === campos.descricao) return null;
    return { ...campos, corrigiu: true };
  }

  if (camposInfracaoInvertidos(titulo, descricao)) {
    const campos = normalizarCamposInfracaoCliente({
      textoDetran: descricao,
      dataAutuacao: data,
      numeroAuto: auto,
    });
    return { ...campos, corrigiu: true };
  }

  if (!titulo && descricao && !pareceDescricaoInfracaoCobranca(descricao)) {
    const campos = normalizarCamposInfracaoCliente({
      textoDetran: descricao,
      dataAutuacao: data,
      numeroAuto: auto,
    });
    return { ...campos, corrigiu: true };
  }

  return null;
}

/** Normaliza titulo (DETRAN) + descricao (padrão Lanza) ao gravar infração. */
export function normalizarCamposInfracaoCliente(args: {
  textoDetran: string;
  dataAutuacao: string;
  numeroAuto?: string;
  paga?: boolean;
  situacao?: string;
  /** Quando já veio do Rastreame no formato de cobrança, preserva (legado ou novo). */
  descricaoRastreame?: string | null;
}): { titulo: string; descricao: string } {
  const detran = String(args.textoDetran ?? "").trim();
  const rastreame = String(args.descricaoRastreame ?? "").trim();
  if (rastreame && pareceDescricaoInfracaoCobranca(rastreame)) {
    return {
      titulo: detran || rastreame,
      descricao: rastreame,
    };
  }
  return {
    titulo: detran,
    descricao: descricaoInfracaoCliente(detran, args.dataAutuacao, args.numeroAuto),
  };
}

function normStatusDetran(s?: string | null): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLowerCase();
}

/** Infração convertida em advertência no DETRAN (sem débito ao locatário). */
export function infracaoAdvertida(reg: {
  statusInfracao?: string;
  statusDetran?: string;
  situacao?: string;
}): boolean {
  const s = normStatusDetran(
    reg.statusInfracao ?? reg.statusDetran ?? reg.situacao,
  );
  return s === "advertida" || s === "advertido";
}

/** Status DETRAN que não geram cobrança ao locatário (encerramento, sync espelho, etc.). */
export function infracaoNaoCobravelDetran(reg: {
  statusInfracao?: string;
  statusDetran?: string;
  quitadaDetran?: boolean;
}): boolean {
  if (infracaoAdvertida(reg)) return true;
  if (reg.quitadaDetran === true) return true;
  const s = normStatusDetran(reg.statusInfracao ?? reg.statusDetran);
  return s === "paga" || s === "justificada";
}

function autoInfracaoEspelhoRastreame(auto?: string): boolean {
  return /^RAST-\d+$/i.test(String(auto ?? "").trim());
}

/**
 * Espelho Rastreame puro (auto `RAST-*` ou `origem: rastreame` sem auto DETRAN) — omitir em relatórios.
 * Linhas com auto DETRAN (`P0…`, `J…`) ou `detranAutoInfracao` permanecem — são a fonte cobrável,
 * mesmo após pull do Gastos Gerais sobrescrever `origem` para `rastreame`.
 */
export function infracaoEspelhoDuplicataRelatorio(reg: {
  origem?: string;
  autoInfracao?: string;
  detranAutoInfracao?: string | null;
}): boolean {
  const auto = String(reg.autoInfracao ?? "").trim();
  if (autoInfracaoEspelhoRastreame(auto)) return true;
  if (reg.detranAutoInfracao?.trim()) return false;
  if (auto && !autoInfracaoEspelhoRastreame(auto)) return false;
  return reg.origem === "rastreame";
}

/** Infração entra na listagem de relatórios (cobrança / encerramento) — qualquer status. */
export function infracaoIncluirListagemRelatorio(reg: {
  categoria?: string;
  ativo?: boolean;
  origem?: string;
  autoInfracao?: string;
  detranAutoInfracao?: string | null;
}): boolean {
  if (reg.ativo === false) return false;
  if (!isCategoriaInfracao(reg.categoria)) return false;
  if (infracaoEspelhoDuplicataRelatorio(reg)) return false;
  return true;
}

/** Infração quitada no DETRAN (histórico / paga no portal). */
export function infracaoQuitadaDetran(reg: {
  statusInfracao?: string;
  statusDetran?: string;
  quitadaDetran?: boolean;
  paga?: boolean;
}): boolean {
  if (reg.paga === true) return true;
  if (reg.quitadaDetran === true) return true;
  const s = normStatusDetran(reg.statusInfracao ?? reg.statusDetran);
  return s === "paga";
}

export type SituacaoInfracaoResumida =
  | "Em aberto"
  | "Paga DETRAN"
  | "Paga Lanza"
  | "Advertida"
  | "Justificada";

/** Situação exibida no relatório resumido de infrações (coluna Situação). */
export function situacaoInfracaoResumida(
  reg: {
    statusInfracao?: string;
    statusDetran?: string;
    situacao?: string;
    quitadaDetran?: boolean;
    paga?: boolean;
  },
  opts?: { pagaLanza?: boolean },
): SituacaoInfracaoResumida {
  if (opts?.pagaLanza === true || reg.paga === true) return "Paga Lanza";
  const s = normStatusDetran(reg.statusInfracao ?? reg.statusDetran ?? reg.situacao);
  if (s === "advertida" || s === "advertido") return "Advertida";
  if (s === "justificada") return "Justificada";
  if (infracaoQuitadaDetran(reg)) return "Paga DETRAN";
  return "Em aberto";
}

/**
 * Infração entra na listagem de **despesas em aberto** do relatório de cobranças.
 * Somente cobráveis — pagas/advertidas/quitadas no DETRAN vão em `infracoesPagas`.
 */
export function infracaoIncluirListagemDespesasRelatorio(
  reg: {
    statusInfracao?: string;
    statusDetran?: string;
    situacao?: string;
    quitadaDetran?: boolean;
    paga?: boolean;
    autoInfracao?: string;
  },
  pagasAuto?: Set<string>,
): boolean {
  return infracaoCobravelRelatorio(reg, pagasAuto);
}

/** Infração resolvida (paga/advertida/justificada) — histórico no relatório, fora do total. */
export function infracaoResolvidaRelatorio(
  reg: Parameters<typeof infracaoCobravelRelatorio>[0],
  pagasAuto?: Set<string>,
): boolean {
  return !infracaoCobravelRelatorio(reg, pagasAuto);
}

/**
 * Infração entra na listagem "despesas em aberto" do relatório de cobranças.
 * @deprecated Use {@link infracaoIncluirListagemDespesasRelatorio}
 */
export function infracaoIncluirDespesasEmAbertoRelatorio(
  reg: Parameters<typeof infracaoIncluirListagemDespesasRelatorio>[0],
  pagasAuto?: Set<string>,
): boolean {
  return infracaoIncluirListagemDespesasRelatorio(reg, pagasAuto);
}

/** Infração entra no subtotal cobrável (acerto / total a cobrar). */
export function infracaoCobravelRelatorio(
  reg: {
    statusInfracao?: string;
    statusDetran?: string;
    quitadaDetran?: boolean;
    paga?: boolean;
    autoInfracao?: string;
  },
  pagasAuto?: Set<string>,
): boolean {
  const auto = String(reg.autoInfracao ?? "").trim().toUpperCase();
  if (auto && pagasAuto?.has(auto)) return false;
  if (reg.paga === true) return false;
  if (infracaoNaoCobravelDetran(reg)) return false;
  return true;
}

/** @deprecated Use `infracaoIncluirListagemRelatorio` + `infracaoCobravelRelatorio`. */
export function infracaoOcultaRelatorioCobranca(reg: {
  statusInfracao?: string;
  statusDetran?: string;
  quitadaDetran?: boolean;
}): boolean {
  return !infracaoCobravelRelatorio(reg);
}

function rotuloStatusInfracao(
  reg: RotuloGastoInput & {
    statusInfracao?: string;
    statusDetran?: string;
    quitadaDetran?: boolean;
  },
): string | null {
  const s = normStatusDetran(reg.statusInfracao ?? reg.statusDetran ?? reg.situacao);
  if (s === "advertida" || s === "advertido") return "Advertida";
  if (reg.paga === true || reg.quitadaDetran === true) return "Paga";
  if (s === "paga") return "Paga";
  if (s === "justificada") return "Justificada";
  return null;
}

function anexarStatusRotulo(base: string, status: string | null): string {
  if (!status) return base;
  if (new RegExp(`\\(${status}\\)`, "i").test(base)) return base;
  return `${base} (${status})`;
}

/** Infração convertida em débito (boleto) após vencimento da defesa. */
export function infracaoConvertidaEmDebito(reg: {
  convertidaEmDebito?: boolean;
  dataVencimentoOriginal?: string | null;
}): boolean {
  if (reg.convertidaEmDebito === true) return true;
  return !!String(reg.dataVencimentoOriginal ?? "").trim();
}

/** Débito vencido — base para contabilizar juros/multa DETRAN. */
export function infracaoVencidaParaJuros(
  reg: { dataVencimentoOriginal?: string | null },
  refDate = new Date(),
): boolean {
  const venc = String(reg.dataVencimentoOriginal ?? "").trim();
  if (!venc) return false;
  const m = venc.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return false;
  const dt = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 23, 59, 59);
  return refDate > dt;
}

const ATRASADO_RE = /^ATRASADO\s*[-–—:]?\s*/i;

/** Remove o prefixo/tag ATRASADO de um título/descrição. */
export function stripAtrasado(s: string): string {
  return String(s ?? "").replace(ATRASADO_RE, "").trim();
}

/**
 * Normaliza título legado (ex.: "ATRASADO Multa Cinto 10/05/2026 16:44") para
 * `Pagamento infração {tipo} {data}`, preservando a data/hora embutida no texto.
 */
export function normalizarTituloMulta(s: string): string {
  const base = stripAtrasado(s);
  if (/^pagamento\s+infra[cç][aã]o\b/i.test(base)) return base;
  const tipo = tipoInfracao(base);
  const m = base.match(/(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2})?)/);
  const dt = m ? m[1]!.trim() : "";
  return dt ? `Pagamento infração ${tipo} ${dt}` : `Pagamento infração ${tipo}`;
}

export type RotuloGastoInput = {
  categoria?: string;
  descricao?: string;
  titulo?: string;
  dataAutuacao?: string;
  numeroAuto?: string;
  autoInfracao?: string;
  paga?: boolean;
  situacao?: string;
  statusInfracao?: string;
  statusDetran?: string;
  quitadaDetran?: boolean;
};

/** Dinheiro ainda não recebido na Lanza (`paga` é a fonte de verdade). */
export function gastoClienteEmAberto(reg: RotuloGastoInput): boolean {
  return reg.paga !== true;
}

/** Rótulo de infração em relatórios e cobranças — descrição canônica (sem ATRASADO). */
export function rotuloInfracaoCobranca(reg: RotuloGastoInput): string {
  const auto = reg.numeroAuto ?? reg.autoInfracao;
  const info = String(reg.descricao ?? "").trim();
  let base = stripAtrasado(info);
  if (pareceDescricaoInfracaoCobranca(base) && /^Multa\s/i.test(base)) {
    base = normalizarTituloMulta(base);
  } else if (!pareceDescricaoInfracaoCobranca(base)) {
    const detran = reg.titulo?.trim() || info;
    base = tituloInfracaoBase(detran, reg.dataAutuacao ?? "", auto);
  }
  if (!base) return "(sem título)";
  const status = rotuloStatusInfracao(reg);
  return anexarStatusRotulo(base, status);
}

/** Rótulo exibido/cobrado — igual ao campo `info` do Rastreame (sem prefixar ATRASADO). */
export function rotuloGastoClienteDespesa(reg: RotuloGastoInput): string {
  if (isCategoriaInfracao(reg.categoria)) {
    const info = String(reg.descricao ?? "").trim();
    if (pareceDescricaoInfracaoCobranca(info)) {
      const base = stripAtrasado(info);
      return /^Multa\s/i.test(base) ? normalizarTituloMulta(base) : base;
    }
    const detran = reg.titulo?.trim() || info;
    const auto = reg.numeroAuto ?? reg.autoInfracao;
    return tituloInfracaoBase(detran, reg.dataAutuacao ?? "", auto);
  }
  return stripAtrasado(String(reg.descricao ?? "").trim());
}
