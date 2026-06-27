/**
 * Título e classificação de infrações de trânsito.
 *
 * Convenção Lanza (decisão 28/06/2026):
 * - `descricao` guarda o **texto cru do DETRAN** (ex.: "TRANSITAR EM VEL SUPERIOR À MÁXIMA PERMITIDA EM ATÉ 20%").
 * - `titulo` guarda o **rótulo curto** para o Gastos Gerais do Rastreame: `Multa {tipo} - {dataAutuacao}`.
 *   A tag `ATRASADO` (débito em aberto) é aplicada na hora do push (fonte única: skill cadastro-recebimento),
 *   resultando em `ATRASADO Multa {tipo} - {dataAutuacao}`.
 */

function norm(s: string): string {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

/** Categoria é infração de trânsito? */
export function isCategoriaInfracao(categoria?: string): boolean {
  return norm(categoria ?? "Infração").startsWith("infra");
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

/** Monta o título base (sem a tag ATRASADO): `Multa {tipo} - {dataAutuacao}`. */
export function tituloInfracaoBase(descricao: string, dataAutuacao: string): string {
  const tipo = tipoInfracao(descricao);
  const dt = String(dataAutuacao ?? "").trim();
  return dt ? `Multa ${tipo} - ${dt}` : `Multa ${tipo}`;
}

const ATRASADO_RE = /^ATRASADO\s*[-–—:]?\s*/i;

/** Remove o prefixo/tag ATRASADO de um título/descrição. */
export function stripAtrasado(s: string): string {
  return String(s ?? "").replace(ATRASADO_RE, "").trim();
}

/** Heurística: a string parece um título de multa (origem Rastreame) e não o texto do DETRAN? */
export function pareceTituloMulta(s: string): boolean {
  return /^(atrasado\s+)?multa\b/i.test(String(s ?? "").trim());
}

/**
 * Normaliza um título antigo (ex.: "ATRASADO Multa Cinto 10/05/2026 16:44") para o
 * padrão `Multa {tipo} - {data}`, preservando a data/hora embutida no texto.
 */
export function normalizarTituloMulta(s: string): string {
  const base = stripAtrasado(s);
  const tipo = tipoInfracao(base);
  const m = base.match(/(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2})?)/);
  const dt = m ? m[1]!.trim() : "";
  return dt ? `Multa ${tipo} - ${dt}` : `Multa ${tipo}`;
}
