import fs from "node:fs";
import path from "node:path";
import PizZip from "pizzip";
import { exportDocxToPdfWin } from "./exportDocxToPdf.js";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { brl, cap, valorExtenso } from "./valorExtenso.js";
import { defaultContratosDir } from "./lanzaPaths.js";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/** Contrato: Arial 9pt em todo o documento (Word usa meios-pontos: 9pt = 18). */
const CONTRATO_FONT = "Arial";
const CONTRATO_FONT_SZ = "18";

const _MESES = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

const UF_NOME: Record<string, string> = {
  SC: "Santa Catarina",
  SP: "São Paulo",
  RS: "Rio Grande do Sul",
  PR: "Paraná",
  RJ: "Rio de Janeiro",
  MG: "Minas Gerais",
  BA: "Bahia",
  PE: "Pernambuco",
  CE: "Ceará",
  GO: "Goiás",
  DF: "Distrito Federal",
  ES: "Espírito Santo",
};

function fipeUrlMesAtual(url: string): string {
  if (!url) return url;
  const hoje = new Date();
  return url.replace(
    /\d{1,2}-\d{4}/,
    `${hoje.getMonth() + 1}-${hoje.getFullYear()}`,
  );
}

function parseData(s: string): Date {
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) throw new Error(`Data inválida: ${s}`);
  return new Date(parseInt(m[3]!, 10), parseInt(m[2]!, 10) - 1, parseInt(m[1]!, 10));
}

function addDays(d: Date, days: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}

function fmtDataHora(d: Date, hora: string): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy} as ${hora}`;
}

function getPText(p: Element): string {
  const ts = p.getElementsByTagNameNS(W, "t");
  let out = "";
  for (let i = 0; i < ts.length; i++) {
    out += ts[i]!.textContent ?? "";
  }
  return out;
}

function removeHyperlinks(p: Element): void {
  const hls = Array.from(p.getElementsByTagNameNS(W, "hyperlink"));
  for (const hl of hls) {
    const par = hl.parentNode;
    if (par) par.removeChild(hl);
  }
}

function clearParagraphRuns(p: Element): void {
  const toRemove: Node[] = [];
  for (let i = 0; i < p.childNodes.length; i++) {
    const c = p.childNodes[i]!;
    if (c.nodeType !== 1) {
      toRemove.push(c);
      continue;
    }
    const el = c as Element;
    if (el.namespaceURI === W && el.localName === "pPr") continue;
    toRemove.push(c);
  }
  for (const n of toRemove) {
    p.removeChild(n);
  }
}

function runIsBold(rPr: Element | null): boolean {
  if (!rPr) return false;
  const boldTags = rPr.getElementsByTagNameNS(W, "b");
  for (let i = 0; i < boldTags.length; i++) {
    const b = boldTags[i] as Element;
    const off = b.getAttributeNS(W, "val") ?? b.getAttribute("w:val");
    if (off !== "0" && off !== "false") return true;
  }
  return false;
}

function applyContratoFontRPr(doc: Document, rPr: Element, bold: boolean): void {
  const remove: Element[] = [];
  for (let i = 0; i < rPr.childNodes.length; i++) {
    const node = rPr.childNodes[i];
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    if (el.namespaceURI === W) {
      const ln = el.localName;
      if (
        ln === "rFonts" ||
        ln === "sz" ||
        ln === "szCs" ||
        ln === "b" ||
        ln === "bCs"
      ) {
        remove.push(el);
      }
    }
  }
  for (const el of remove) rPr.removeChild(el);

  const rFonts = doc.createElementNS(W, "w:rFonts");
  rFonts.setAttributeNS(W, "ascii", CONTRATO_FONT);
  rFonts.setAttributeNS(W, "hAnsi", CONTRATO_FONT);
  rFonts.setAttributeNS(W, "cs", CONTRATO_FONT);
  rFonts.setAttributeNS(W, "eastAsia", CONTRATO_FONT);
  rPr.insertBefore(rFonts, rPr.firstChild);

  const sz = doc.createElementNS(W, "w:sz");
  sz.setAttributeNS(W, "val", CONTRATO_FONT_SZ);
  rPr.appendChild(sz);

  const szCs = doc.createElementNS(W, "w:szCs");
  szCs.setAttributeNS(W, "val", CONTRATO_FONT_SZ);
  rPr.appendChild(szCs);

  if (bold) {
    rPr.appendChild(doc.createElementNS(W, "w:b"));
  }
}

function ensureRunFont(doc: Document, r: Element, bold?: boolean): void {
  let rPr: Element | null = null;
  for (let i = 0; i < r.childNodes.length; i++) {
    const node = r.childNodes[i];
    if (node.nodeType === 1 && (node as Element).localName === "rPr") {
      rPr = node as Element;
      break;
    }
  }
  const useBold = bold ?? runIsBold(rPr);
  if (!rPr) {
    rPr = doc.createElementNS(W, "w:rPr");
    r.insertBefore(rPr, r.firstChild);
  }
  applyContratoFontRPr(doc, rPr, useBold);
}

/** Garante Arial 9 em todas as runs e defaults de parágrafo (substitui Calibri 11 do template). */
function normalizeDocumentFonts(dom: Document): void {
  const root = dom.documentElement;
  const runs = root.getElementsByTagNameNS(W, "r");
  for (let i = 0; i < runs.length; i++) {
    ensureRunFont(dom, runs[i] as Element);
  }

  const paragraphs = root.getElementsByTagNameNS(W, "p");
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i] as Element;
    for (let j = 0; j < p.childNodes.length; j++) {
      const node = p.childNodes[j];
      if (node.nodeType !== 1 || (node as Element).localName !== "pPr") continue;
      const pPr = node as Element;
      for (let k = 0; k < pPr.childNodes.length; k++) {
        const child = pPr.childNodes[k];
        if (child.nodeType === 1 && (child as Element).localName === "rPr") {
          applyContratoFontRPr(dom, child as Element, runIsBold(child as Element));
        }
      }
    }
  }

  const docDefaults = root.getElementsByTagNameNS(W, "docDefaults");
  for (let i = 0; i < docDefaults.length; i++) {
    const rPrDefault = docDefaults[i]!.getElementsByTagNameNS(W, "rPr");
    for (let j = 0; j < rPrDefault.length; j++) {
      applyContratoFontRPr(dom, rPrDefault[j] as Element, false);
    }
  }

  const styles = root.getElementsByTagNameNS(W, "style");
  for (let i = 0; i < styles.length; i++) {
    const styleRPr = (styles[i] as Element).getElementsByTagNameNS(W, "rPr");
    for (let j = 0; j < styleRPr.length; j++) {
      applyContratoFontRPr(dom, styleRPr[j] as Element, runIsBold(styleRPr[j] as Element));
    }
  }
}

function appendRun(
  doc: Document,
  p: Element,
  text: string,
  bold: boolean,
): void {
  const r = doc.createElementNS(W, "w:r");
  const rPr = doc.createElementNS(W, "w:rPr");
  applyContratoFontRPr(doc, rPr, bold);
  r.appendChild(rPr);
  const t = doc.createElementNS(W, "w:t");
  if (/^\s|\s$/.test(text)) {
    t.setAttribute("xml:space", "preserve");
  }
  t.appendChild(doc.createTextNode(text));
  r.appendChild(t);
  p.appendChild(r);
}

function ensureParagraphPr(doc: Document, p: Element): Element {
  for (let i = 0; i < p.childNodes.length; i++) {
    const n = p.childNodes[i]!;
    if (n.nodeType === 1 && (n as Element).localName === "pPr") return n as Element;
  }
  const pPr = doc.createElementNS(W, "w:pPr");
  if (p.firstChild) p.insertBefore(pPr, p.firstChild);
  else p.appendChild(pPr);
  return pPr;
}

/** Espaçamento de parágrafo Word (twips: 20 = 1pt). */
function setParagraphSpacing(
  doc: Document,
  p: Element,
  opts: { before?: number; after?: number },
): void {
  const pPr = ensureParagraphPr(doc, p);
  let spacing: Element | null = null;
  for (let i = 0; i < pPr.childNodes.length; i++) {
    const n = pPr.childNodes[i]!;
    if (n.nodeType === 1 && (n as Element).localName === "spacing") {
      spacing = n as Element;
      break;
    }
  }
  if (!spacing) {
    spacing = doc.createElementNS(W, "w:spacing");
    pPr.appendChild(spacing);
  }
  if (opts.before != null) spacing.setAttributeNS(W, "before", String(opts.before));
  if (opts.after != null) spacing.setAttributeNS(W, "after", String(opts.after));
}

function insertParagraphAfter(doc: Document, body: Element, ref: Element): Element {
  const p = doc.createElementNS(W, "w:p");
  const refPPr = ref.getElementsByTagNameNS(W, "pPr")[0];
  if (refPPr) p.appendChild(refPPr.cloneNode(true));
  if (ref.nextSibling) body.insertBefore(p, ref.nextSibling);
  else body.appendChild(p);
  return p;
}

function setParagraphRich(
  doc: Document,
  p: Element,
  segments: [string, boolean][],
): void {
  const segs = segments.filter((x) => x[0]);
  if (!segs.length) return;
  removeHyperlinks(p);
  clearParagraphRuns(p);
  for (const [t, b] of segs) {
    appendRun(doc, p, t, b);
  }
}

function deleteParagraph(p: Element): void {
  const par = p.parentNode;
  if (par) par.removeChild(p);
}

function N(t: string): [string, boolean] {
  return [t, false];
}
function B(t: string): [string, boolean] {
  return [t, true];
}

function boldSubstring(
  segments: [string, boolean][],
  sub: string,
): [string, boolean][] {
  if (!sub) return segments;
  const out: [string, boolean][] = [];
  for (const [t, b] of segments) {
    if (b || !t.includes(sub)) {
      out.push([t, b]);
      continue;
    }
    const i = t.indexOf(sub);
    if (i > 0) out.push([t.slice(0, i), false]);
    out.push([sub, true]);
    if (i + sub.length < t.length) {
      out.push([t.slice(i + sub.length), false]);
    }
  }
  return out;
}

type RichSeg = [string, boolean];

function mergeRichSegments(...parts: RichSeg[][]): RichSeg[] {
  return parts.flat();
}

/** Valores monetários do template padrão — não negritar se iguais. */
const TEMPLATE_MONEY_REFS = [650.0, 120.0, 1500.0, 360.0];

function boldAllPatternMatches(
  segs: RichSeg[],
  text: string,
  pattern: RegExp,
): RichSeg[] {
  const re = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g",
  );
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      segs = boldSubstring(segs, m[0]);
    }
  }
  return segs;
}

/** Negrito em todo o sufixo customizado da cláusula 3.3 (valores, datas, parcelas). */
function richBoldSuffixClausula33(suffix: string): RichSeg[] {
  let segs: RichSeg[] = [N(suffix)];
  segs = boldAllPatternMatches(segs, suffix, /R\$\s*[\d.]+,\d{2}\s*\([^)]+\)/g);
  segs = boldAllPatternMatches(segs, suffix, /\d{2}\/\d{2}\/\d{4}/g);
  segs = boldAllPatternMatches(
    segs,
    suffix,
    /\d+\s*\([A-Za-záéíóúâêôãçÁÉÍÓÚÂÊÔÃÇ\s]+\)/g,
  );
  return segs;
}

/** Negrito em valores monetários da base que diferem do template padrão. */
function richBaseMoneyNotTemplate(text: string, templateRefs: number[]): RichSeg[] {
  let segs: RichSeg[] = [N(text)];
  const moneyRe = /R\$\s*([\d.]+,\d{2})\s*\([^)]+\)/g;
  const re = new RegExp(moneyRe.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const num = parseFloat(m[1]!.replace(/\./g, "").replace(",", "."));
    const isTemplate = templateRefs.some((ref) => Math.abs(num - ref) < 0.005);
    if (!isTemplate) {
      segs = boldSubstring(segs, m[0]);
    }
  }
  return segs;
}

function richParagraphSuffix(
  fullText: string,
  suffix: string,
  templateRefs: number[],
  extraBold?: string[],
): RichSeg[] {
  const idx = fullText.lastIndexOf(suffix);
  const basePart = idx >= 0 ? fullText.slice(0, idx) : fullText;
  const suffPart = idx >= 0 ? fullText.slice(idx) : "";
  let segs = mergeRichSegments(
    richBaseMoneyNotTemplate(basePart, templateRefs),
    suffPart ? richBoldSuffixClausula33(suffPart) : [],
  );
  for (const sub of extraBold ?? []) {
    if (sub) segs = boldSubstring(segs, sub);
  }
  return segs;
}

function richFromPattern(
  text: string,
  pat: RegExp,
  troca: (m: RegExpExecArray) => string,
): [string, boolean][] {
  const segs: [string, boolean][] = [];
  let last = 0;
  const re = new RegExp(pat.source, pat.flags.includes("g") ? pat.flags : pat.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segs.push(N(text.slice(last, m.index)));
    const novo = troca(m);
    segs.push([novo, novo !== m[0]]);
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push(N(text.slice(last)));
  return segs;
}

function formatNomeTitulo(nome: string): string {
  return nome
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** Caminho da pasta do contrato (sem gravar ficheiros). */
export function resolverPastaContratoFromDados(dados: GerarContratoDados): string {
  const dini = parseData(dados.prazo.inicio);
  const nomeCli = formatNomeTitulo(dados.cliente.nome);
  const baseDir = dados.contratosDir ?? defaultContratosDir();
  return path.join(
    baseDir,
    `${String(dini.getDate()).padStart(2, "0")}.${String(dini.getMonth() + 1).padStart(2, "0")}.${dini.getFullYear()} - ${nomeCli}`,
  );
}

function sanitizarNomeArquivo(base: string): string {
  return base.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
}

export function resolverNomeArquivoContrato(nomeCliente: string): string {
  const nome = String(nomeCliente ?? "").trim() || "Cliente";
  return sanitizarNomeArquivo(`Contrato - ${formatNomeTitulo(nome)}`);
}

/** Nome de ficheiro para download (Word/PDF): `Contrato - Nome.ext`. */
export function nomeArquivoContratoComExtensao(
  nomeCliente: string,
  ext: "docx" | "pdf",
): string {
  return `${resolverNomeArquivoContrato(nomeCliente)}.${ext}`;
}

/** Nome do locatário no corpo do contrato e assinatura — sempre maiúsculas. */
function formatNomeLocatarioContrato(nome: string): string {
  return nome.replace(/\s+/g, " ").trim().toLocaleUpperCase("pt-BR");
}

/** Nomes placeholder do template v3 — bloco de assinatura final. */
const ASSINATURA_LOCATARIO_TEMPLATE = "RAFAEL MOREIRA PONTEL";
const ASSINATURA_LOCADOR_TEMPLATE = "JOSE FELIPE BARRETO RODRIGUES";

/** Espaço vertical entre blocos de assinatura (locatário / locador). 720 twips ≈ 36pt. */
const ASSINATURA_SPACING_TWIPS = 720;

function aplicarNomesAssinaturaFinal(
  dom: Document,
  body: Element,
  nomeCliente: string,
): void {
  const locNome = formatNomeLocatarioContrato(nomeCliente);
  const paragraphs = bodyParagraphs(body);

  let idxLocatario = -1;
  let idxLocador = -1;
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const up = getPText(paragraphs[i]!).toUpperCase();
    if (idxLocador < 0 && up.includes(ASSINATURA_LOCADOR_TEMPLATE)) idxLocador = i;
    if (idxLocatario < 0 && up.includes(ASSINATURA_LOCATARIO_TEMPLATE)) idxLocatario = i;
    if (idxLocatario >= 0 && idxLocador >= 0) break;
  }
  if (idxLocatario < 0) return;

  const pLoc = paragraphs[idxLocatario]!;
  const fullLoc = getPText(pLoc);
  const upLoc = fullLoc.toUpperCase();

  if (idxLocador === idxLocatario) {
    const idxLoc = upLoc.indexOf(ASSINATURA_LOCATARIO_TEMPLATE);
    const idxLand = upLoc.indexOf(ASSINATURA_LOCADOR_TEMPLATE);
    if (idxLand < 0 || idxLand <= idxLoc) {
      setParagraphRich(dom, pLoc, [B(locNome)]);
      return;
    }

    const mid = fullLoc
      .slice(idxLoc + ASSINATURA_LOCATARIO_TEMPLATE.length, idxLand)
      .replace(/\s+/g, " ")
      .trim();

    setParagraphRich(dom, pLoc, [B(locNome)]);
    setParagraphSpacing(dom, pLoc, { after: ASSINATURA_SPACING_TWIPS / 2 });

    const pSpacer = insertParagraphAfter(dom, body, pLoc);
    setParagraphSpacing(dom, pSpacer, {
      before: ASSINATURA_SPACING_TWIPS / 2,
      after: ASSINATURA_SPACING_TWIPS / 2,
    });

    const pLand = insertParagraphAfter(dom, body, pSpacer);
    const landSegs: [string, boolean][] = mid ? [N(`${mid} `)] : [];
    landSegs.push(B(ASSINATURA_LOCADOR_TEMPLATE));
    setParagraphRich(dom, pLand, landSegs);
    setParagraphSpacing(dom, pLand, { before: ASSINATURA_SPACING_TWIPS / 2 });
    return;
  }

  setParagraphRich(dom, pLoc, [B(locNome)]);
  setParagraphSpacing(dom, pLoc, { after: ASSINATURA_SPACING_TWIPS / 2 });

  if (idxLocador >= 0) {
    const pLand = paragraphs[idxLocador]!;
    if (idxLocador === idxLocatario + 1) {
      const pSpacer = insertParagraphAfter(dom, body, pLoc);
      setParagraphSpacing(dom, pSpacer, {
        before: ASSINATURA_SPACING_TWIPS / 2,
        after: ASSINATURA_SPACING_TWIPS / 2,
      });
    } else {
      setParagraphSpacing(dom, pLand, { before: ASSINATURA_SPACING_TWIPS / 2 });
    }
  }
}

function bodyParagraphs(body: Element): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < body.childNodes.length; i++) {
    const n = body.childNodes[i]!;
    if (n.nodeType !== 1) continue;
    const el = n as Element;
    if (el.namespaceURI === W && el.localName === "p") out.push(el);
  }
  return out;
}

export type CaucaoParcelas = {
  /** Saldo de caução em aberto após entrada. */
  aberto: number;
  /** Quantidade de parcelas semanais. */
  parcelas: number;
  /** Valor de cada parcela de caução. */
  valorParcela: number;
  /** Datas de vencimento (DD/MM/AAAA). */
  datas: string[];
};

/** Caução integral parcelada junto com cada pagamento semanal (sem saldo em aberto). */
export type CaucaoSemanalParcelado = {
  parcelas: number;
  valorParcela: number;
};

/** Primeira semana/período parcial na retirada; restante diluído nas próximas parcelas (cláusula 3.2). */
export type SemanaParcelas = {
  valorEntrada: number;
  parcelas: number;
  valorParcela: number;
  /** Datas de vencimento das parcelas restantes (DD/MM/AAAA). */
  datas?: string[];
};

export type GerarContratoDados = {
  template: string;
  contratosDir?: string;
  cnhArquivo?: string;
  cliente: {
    id?: string;
    nome: string;
    cpf: string;
    endereco?: Record<string, string>;
  };
  veiculo: Record<string, string> & { id?: string };
  prazo: { dias: number; inicio: string; hora?: string; fim?: string };
  valores: { semana: number; caucao: number; diaria?: number; mensal?: number };
  /** Modalidade de cobrança persistida no registro (semanal | diaria | mensal). */
  tipoContrato?: "semanal" | "diaria" | "mensal";
  cnhCategoria?: string;
  diaPagamento?: string;
  /** Texto extra na cláusula 3.3 — saldo de caução em aberto com datas. */
  caucaoParcelas?: CaucaoParcelas;
  /** Texto extra na cláusula 3.3 — caução integral parcelada nas semanas. */
  caucaoSemanalParcelado?: CaucaoSemanalParcelado;
  /** Ajuste na cláusula 3.2 — parcelamento da primeira semana. */
  semanaParcelas?: SemanaParcelas;
  assinatura?: { data?: string; cidade?: string; estado?: string };
};

const PARCELAS_FEM: Record<number, string> = {
  1: "uma",
  2: "duas",
  3: "três",
  4: "quatro",
  5: "cinco",
  6: "seis",
  7: "sete",
  8: "oito",
  9: "nove",
  10: "dez",
  11: "onze",
  12: "doze",
};

function parcelasExtensoFem(n: number): string {
  return PARCELAS_FEM[n] ?? String(n);
}

function formatDatasLista(datas: string[]): string {
  if (datas.length === 0) return "";
  if (datas.length === 1) return datas[0]!;
  if (datas.length === 2) return `${datas[0]} e ${datas[1]}`;
  return `${datas.slice(0, -1).join(", ")} e ${datas[datas.length - 1]}`;
}

function buildCaucaoParcelasText(cp: CaucaoParcelas, semana: number): string {
  const totalSemanal = semana + cp.valorParcela;
  return (
    ` Onde ficou em aberto R$${brl(cp.aberto)} (${cap(valorExtenso(cp.aberto))}) e será pago em ${cp.parcelas} (${parcelasExtensoFem(cp.parcelas)}) parcelas no valor de R$${brl(cp.valorParcela)} (${cap(valorExtenso(cp.valorParcela))}) juntamente com valor semanal totalizando R$${brl(totalSemanal)} nos dias ${formatDatasLista(cp.datas)}.`
  );
}

function buildCaucaoSemanalParceladoText(cp: CaucaoSemanalParcelado): string {
  return (
    ` Onde o pagamento deverá ser efetuado juntamente com o pagamento semanal parcelado em ${cp.parcelas} (${parcelasExtensoFem(cp.parcelas)}) vezes, totalizando R$${brl(cp.valorParcela)} (${cap(valorExtenso(cp.valorParcela))}) por semana.`
  );
}

function buildSemanaParcelasText(sp: SemanaParcelas): string {
  const restante = Math.round(sp.parcelas * sp.valorParcela * 100) / 100;
  const datasSuffix =
    sp.datas && sp.datas.length > 0 ? ` nos dias ${formatDatasLista(sp.datas)}` : "";
  return (
    ` no valor de R$${brl(sp.valorEntrada)} (${cap(valorExtenso(sp.valorEntrada))}) e o restante deverá ser pago juntamente com as próximas ${sp.parcelas} (${parcelasExtensoFem(sp.parcelas)}) semanas no valor de R$${brl(sp.valorParcela)} (${cap(valorExtenso(sp.valorParcela))}), totalizando R$${brl(restante)} (${cap(valorExtenso(restante))})${datasSuffix}.`
  );
}

function aplicarSuffixClausula33(dom: Document, body: Element, suffix: string): void {
  const anchorMesmoParagrafo = /(entre outras despesas)\.?(\s*3\.4)/i;
  const anchorFimParagrafo = /(entre outras despesas)\.?\s*$/i;
  for (const p of bodyParagraphs(body)) {
    const orig = getPText(p);
    if (!orig.trim().startsWith("3.3")) continue;
    let novo: string | null = null;
    if (anchorMesmoParagrafo.test(orig)) {
      novo = orig.replace(anchorMesmoParagrafo, (_m, g1, g2) => `${g1}.${suffix}${g2}`);
    } else if (anchorFimParagrafo.test(orig.trim())) {
      novo = orig.trim().replace(anchorFimParagrafo, (_m, g1) => `${g1}.${suffix}`);
    }
    if (novo) {
      setParagraphRich(dom, p, richParagraphSuffix(novo, suffix, TEMPLATE_MONEY_REFS));
      return;
    }
  }
}

function aplicarSemanaParcelasClausula32(
  dom: Document,
  body: Element,
  sp: SemanaParcelas,
  diaPag?: string,
): void {
  const suffix = buildSemanaParcelasText(sp);
  const anchorMesmoParagrafo = /(pelo LOCATÁRIO)\.(\s*3\.3)/i;
  const anchorFimParagrafo = /(pelo LOCATÁRIO)\.(\s*)$/i;
  for (const p of bodyParagraphs(body)) {
    const orig = getPText(p);
    if (!orig.trim().startsWith("3.2 O pagamento")) continue;
    let novo: string | null = null;
    if (anchorMesmoParagrafo.test(orig)) {
      novo = orig.replace(anchorMesmoParagrafo, `$1${suffix}$2`);
    } else if (anchorFimParagrafo.test(orig.trim())) {
      novo = orig.trim().replace(anchorFimParagrafo, `$1${suffix}`);
    }
    if (novo) {
      setParagraphRich(
        dom,
        p,
        richParagraphSuffix(novo, suffix, TEMPLATE_MONEY_REFS, diaPag ? [diaPag] : undefined),
      );
      return;
    }
  }
}

export function gerar(dados: GerarContratoDados): {
  pasta: string;
  docx: string;
  pdf: string | null;
  cnh: string | null;
} {
  const buf = fs.readFileSync(dados.template);
  const zip = new PizZip(buf);
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("word/document.xml ausente no .docx");
  const xml = entry.asText();
  const dom = new DOMParser().parseFromString(xml, "application/xml");
  const docEl = dom.documentElement;
  const bodies = dom.getElementsByTagNameNS(W, "body");
  const body = bodies[0];
  if (!body) throw new Error("w:body não encontrado");

  const paragraphs = bodyParagraphs(body);

  const cli = dados.cliente;
  const nomeLocatario = formatNomeLocatarioContrato(cli.nome);
  const end = cli.endereco ?? {};
  const veic = dados.veiculo;
  const prazo = dados.prazo;
  const val = dados.valores;
  const diaria = Number(val.diaria ?? 120);
  const semana = Number(val.semana);
  const caucao = Number(val.caucao);
  const tresDiarias = diaria * 3;
  const categoria = dados.cnhCategoria ?? "B";

  const hora = prazo.hora ?? "18:00";
  const dini = parseData(prazo.inicio);
  const dfim = prazo.fim?.trim() ? parseData(prazo.fim.trim()) : addDays(dini, Number(prazo.dias));
  const inicioStr = fmtDataHora(dini, hora);
  const fimStr = fmtDataHora(dfim, hora);

  const ufKey = (end.uf ?? "").toUpperCase();
  const estadoCli =
    end.estado || UF_NOME[ufKey] || end.uf || "";
  let log = end.logradouro ?? "";
  if (end.numero) log += `, ${end.numero}`;
  if (end.complemento) log += `, ${end.complemento}`;

  let mm = veic.marcaModelo ?? "";
  const fm = (veic.fipeModelo ?? "").trim();
  if (fm) mm += ` (${fm})`;

  const fipeUrl = fipeUrlMesAtual(veic.fipe ?? "");

  for (const p of paragraphs) {
    const t = getPText(p).trim();
    if (t.startsWith("LOCAT") && getPText(p).includes("CPF")) {
      setParagraphRich(dom, p, [
        N("LOCATÁRIO(a): "),
        B(nomeLocatario),
        N(", inscrito no CPF sob o n° "),
        B(cli.cpf),
        N(", residente e domiciliado na "),
        B(log),
        N(", bairro "),
        B(end.bairro ?? ""),
        N(", cidade "),
        B(end.cidade ?? ""),
        N(", estado "),
        B(estadoCli),
        N(", CEP "),
        B(end.cep ?? ""),
        N("."),
      ]);
      break;
    }
  }

  const segV: [string, boolean][] = [
    N("1.1 O presente contrato tem como OBJETO a locação do automóvel de placa: "),
    B(veic.placa),
    N(", marca/modelo "),
    B(mm),
  ];
  if (veic.chassi) segV.push(N(", Chassi "), B(veic.chassi));
  if (veic.renavam) segV.push(N(", RENAVAM "), B(veic.renavam));
  segV.push(
    N(", ano/modelo "),
    B(veic.anoModelo),
    N(", cor "),
    B(veic.cor),
    N("."),
  );

  const vehPars = paragraphs.filter((p) =>
    getPText(p).trim().startsWith("1.1 O presente"),
  );
  const fipePars = paragraphs.filter((p) =>
    getPText(p).trim().startsWith("1.1.1"),
  );
  if (vehPars.length) {
    setParagraphRich(dom, vehPars[0]!, segV);
    for (let i = 1; i < vehPars.length; i++) deleteParagraph(vehPars[i]!);
  }
  if (fipePars.length) {
    setParagraphRich(dom, fipePars[0]!, [
      N("1.1.1 Informações tabela Fipe: "),
      B(fipeUrl),
    ]);
    for (let i = 1; i < fipePars.length; i++) deleteParagraph(fipePars[i]!);
  }

  for (const p of bodyParagraphs(body)) {
    const t = getPText(p).trim();
    if (t.startsWith("1.2 A presente")) {
      setParagraphRich(dom, p, [
        N("1.2 A presente locação terá o lapso temporal de validade de "),
        B(`${Number(prazo.dias)} dias`),
        N(", podendo ser renovado por vontade das partes, iniciando no dia "),
        B(inicioStr),
        N(" e terminando no dia "),
        B(fimStr),
        N(
          ", com tolerância de no máximo 1 hora. Data na qual o automóvel deverá ser " +
            "devolvido no estado em que foi locado, sem avarias.",
        ),
      ]);
      break;
    }
  }

  const catpat = /(categoria\s*["“])([^"”]*)(["”])/i;
  for (const p of bodyParagraphs(body)) {
    const full = getPText(p);
    const t = full.trim();
    if (t.startsWith("2.1.") && full.toLowerCase().includes("categoria")) {
      const m = catpat.exec(full);
      if (m) {
        setParagraphRich(dom, p, [
          N(full.slice(0, m.index)),
          N(m[1]!),
          B(categoria),
          N(m[3]!),
          N(full.slice(m.index + m[0].length)),
        ]);
      }
      break;
    }
  }

  const alvos = new Map<number, [number, string]>([
    [650.0, [semana, valorExtenso(semana)]],
    [120.0, [diaria, valorExtenso(diaria)]],
    [1500.0, [caucao, valorExtenso(caucao)]],
    [360.0, [tresDiarias, valorExtenso(tresDiarias)]],
  ]);
  const moneyRe = /R\$\s*([\d.]+,\d{2})\s*\(([^)]*)\)/g;
  function troca(m: RegExpExecArray): string {
    const num = parseFloat(m[1]!.replace(/\./g, "").replace(",", "."));
    for (const [ref, [nv, ext]] of alvos) {
      if (Math.abs(num - ref) < 0.005) {
        return `R$ ${brl(nv)} (${cap(ext)})`;
      }
    }
    return m[0]!;
  }

  const diaPag = dados.diaPagamento;
  for (const p of bodyParagraphs(body)) {
    const orig = getPText(p);
    if (!orig.includes("R$")) continue;
    moneyRe.lastIndex = 0;
    if (!moneyRe.test(orig)) continue;

    moneyRe.lastIndex = 0;
    let t = orig;
    const is32 = orig.trim().startsWith("3.2 O pagamento");
    if (is32 && diaPag) {
      t = t.replace(/todas as segundas-feiras/g, diaPag);
    }
    const novo = t.replace(moneyRe, (whole, g1, g2) => {
      const m = { 0: whole, 1: g1, 2: g2 } as unknown as RegExpExecArray;
      return troca(m);
    });
    if (novo !== orig) {
      let segs = richFromPattern(t, moneyRe, (m) => troca(m));
      if (is32 && diaPag) segs = boldSubstring(segs, diaPag);
      setParagraphRich(dom, p, segs);
    }
  }

  if (dados.semanaParcelas) {
    aplicarSemanaParcelasClausula32(dom, body, dados.semanaParcelas, diaPag);
  }

  if (dados.caucaoParcelas) {
    aplicarSuffixClausula33(dom, body, buildCaucaoParcelasText(dados.caucaoParcelas, semana));
  } else if (dados.caucaoSemanalParcelado) {
    aplicarSuffixClausula33(
      dom,
      body,
      buildCaucaoSemanalParceladoText(dados.caucaoSemanalParcelado),
    );
  }

  const assin = dados.assinatura ?? {};
  let dataAssin = assin.data ?? "auto";
  if (dataAssin === "auto") {
    dataAssin = `${String(dini.getDate()).padStart(2, "0")} de ${_MESES[dini.getMonth()]!} de ${dini.getFullYear()}`;
  }
  const cidadeA = assin.cidade ?? "Tubarão";
  const estadoA = assin.estado ?? "Santa Catarina";
  const dataRe = /\d{1,2} de [A-Za-zçãéíóúâ]+ de \d{4}/;
  for (const p of bodyParagraphs(body)) {
    const full = getPText(p);
    if (dataRe.test(full) && !full.toLowerCase().includes("lapso")) {
      setParagraphRich(dom, p, [
        N(`${cidadeA}, ${estadoA}, `),
        B(dataAssin),
        N("."),
      ]);
      break;
    }
  }

  aplicarNomesAssinaturaFinal(dom, body, cli.nome);

  normalizeDocumentFonts(dom);

  const pasta = resolverPastaContratoFromDados(dados);
  fs.mkdirSync(pasta, { recursive: true });
  const nomeArq = resolverNomeArquivoContrato(cli.nome);
  const saidaDocx = path.join(pasta, `${nomeArq}.docx`);
  const saidaPdf = path.join(pasta, `${nomeArq}.pdf`);

  const newXml = new XMLSerializer().serializeToString(docEl);
  zip.file("word/document.xml", newXml);

  const stylesEntry = zip.file("word/styles.xml");
  if (stylesEntry) {
    const stylesDom = new DOMParser().parseFromString(stylesEntry.asText(), "application/xml");
    normalizeDocumentFonts(stylesDom);
    zip.file(
      "word/styles.xml",
      new XMLSerializer().serializeToString(stylesDom.documentElement),
    );
  }

  fs.writeFileSync(saidaDocx, zip.generate({ type: "nodebuffer" }));

  let pdfOk = false;
  if (process.platform === "win32") {
    pdfOk = exportDocxToPdfWin(path.resolve(saidaDocx), path.resolve(saidaPdf));
  } else {
    console.error("[aviso] PDF via Word COM indisponível neste SO; use ConvertAPI ou baixe o .docx.");
  }

  let cnhDest: string | null = null;
  const cnhSrc = dados.cnhArquivo;
  if (cnhSrc && fs.existsSync(cnhSrc)) {
    cnhDest = path.join(pasta, "CNH.pdf");
    fs.copyFileSync(cnhSrc, cnhDest);
  }

  return {
    pasta,
    docx: saidaDocx,
    pdf: pdfOk ? saidaPdf : null,
    cnh: cnhDest,
  };
}
