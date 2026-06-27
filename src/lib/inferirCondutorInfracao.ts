import fs from "node:fs";
import path from "node:path";

import { docxPlainText } from "./docxPlain.js";
import { defaultContratosDir } from "./lanzaPaths.js";
import { compactPlaca, formatPlacaHyphen } from "./placa.js";
import { REPO_ROOT } from "./repoRoot.js";

const EXCL_PATH =
  /Modelo v3|compra e venda|contrato-compra|Orçamentos|Modelo antigo|\\Copy\\/i;
// NOTA: contratos devolvidos/encerrados NÃO são excluídos — para atribuição
// histórica de infrações, o locatário daquele período é o responsável (a multa
// é da data em que o contrato estava vigente, mesmo que já tenha sido devolvido).

export type CondutorSugerido = {
  condutorId: string | null;
  condutorContrato: string | null;
  clienteNome: string | null;
  aviso: string | null;
};

type Cliente = { id?: string; nome?: string; cpf?: string };

function normNome(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function parseDataPasta(nomePasta: string): Date | null {
  const m4 = nomePasta.match(/^(\d{2})\.(\d{2})\.(\d{4})\s*-\s*/);
  if (m4) {
    const dt = new Date(Number(m4[3]), Number(m4[2]) - 1, Number(m4[1]), 12, 0, 0);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  const m2 = nomePasta.match(/^(\d{2})\.(\d{2})\.(\d{2})(?!\d)\s*-\s*/);
  if (m2) {
    const yy = Number(m2[3]);
    const y = yy >= 50 ? 1900 + yy : 2000 + yy;
    const dt = new Date(y, Number(m2[2]) - 1, Number(m2[1]), 12, 0, 0);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  return null;
}

function clienteDaPasta(nomePasta: string): string | null {
  const m = nomePasta.match(/^\d{2}\.\d{2}\.\d{2,4}\s*-\s*(.+)$/);
  return m ? m[1]!.trim() : null;
}

/** "DD/MM/AAAA HH:mm" ou "DD/MM/AAAA" */
export function parseDataAutuacao(s: string): Date | null {
  const t = String(s || "").trim();
  const m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?/);
  if (!m) return null;
  const h = m[4] !== undefined ? Number(m[4]) : 12;
  const min = m[5] !== undefined ? Number(m[5]) : 0;
  const dt = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), h, min, 0);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function parseDataBr(s: string): Date | null {
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const dt = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 23, 59, 59);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function extrairPlacaDocx(texto: string): string | null {
  const t = texto.normalize("NFD").replace(/\p{M}/gu, "");
  const m = t.match(/placa:\s*([A-Z0-9-]+)/i);
  return m ? formatPlacaHyphen(m[1]!) : null;
}

function extrairCpfDocx(texto: string): string | null {
  const m = texto.match(/CPF sob o n[°º]\s*([\d.\-]+)/i);
  return m ? m[1]!.trim() : null;
}

function addDiasLocal(d: Date, dias: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + dias);
  r.setHours(23, 59, 59, 999);
  return r;
}

function inicioDoDia(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

/** Início/fim EXPLÍCITOS do texto do contrato (sem fallback). */
function extrairPeriodoExplicito(texto: string): { inicio: Date | null; fim: Date | null } {
  const t = texto.normalize("NFD").replace(/\p{M}/gu, "");
  const m = t.match(
    /iniciando no dia\s+(\d{2}\/\d{2}\/\d{4})[^e]+e terminando no dia\s+(\d{2}\/\d{2}\/\d{4})/i,
  );
  if (m) return { inicio: parseDataBr(m[1]!), fim: parseDataBr(m[2]!) };
  return { inicio: null, fim: null };
}

/**
 * Data real de fim da posse a partir do nome da pasta, ex.: "(devolvido 18.05)",
 * "(recuperado 04.05)", "(troca 22.05)". Ano inferido pelo início (vira ano
 * seguinte se o mês do retorno for anterior ao mês de início).
 */
function parseRetornoPasta(nomePasta: string, inicio: Date): Date | null {
  const m = nomePasta.match(
    /\((?:devolvido|recuperado|entregue|recolhido|trocad[oa]|troca)\s+(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\)/i,
  );
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  let yyyy: number;
  if (m[3]) {
    const y = Number(m[3]);
    yyyy = y < 100 ? 2000 + y : y;
  } else {
    yyyy = mm >= inicio.getMonth() + 1 ? inicio.getFullYear() : inicio.getFullYear() + 1;
  }
  const dt = new Date(yyyy, mm - 1, dd, 23, 59, 59);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function loadClientes(): Cliente[] {
  const p = path.join(REPO_ROOT, "database", "clientes.json");
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as { clientes?: Cliente[] };
    return j.clientes ?? [];
  } catch {
    return [];
  }
}

function resolveClienteId(
  clientes: Cliente[],
  cpf: string | null,
  nome: string | null,
): string | null {
  if (cpf) {
    const c = clientes.find((x) => x.cpf === cpf);
    if (c?.id) return c.id;
  }
  if (!nome) return null;
  const alvo = normNome(nome);
  for (const c of clientes) {
    if (c.nome && normNome(c.nome) === alvo && c.id) return c.id;
  }
  for (const c of clientes) {
    if (!c.nome || !c.id) continue;
    const n = normNome(c.nome);
    if (n.includes(alvo) || alvo.includes(n)) return c.id;
  }
  return null;
}

type ContratoCand = {
  pastaContrato: string;
  docx: string;
  clienteNome: string;
  inicio: Date;
  fim: Date;
  placa: string;
};

type ContratoColetado = {
  pastaContrato: string;
  docx: string;
  clienteNome: string;
  inicio: Date;
  fimExplicito: Date | null;
  retorno: Date | null;
  placa: string;
};

function listarContratosNaData(
  root: string,
  data: Date,
  placaAlvo: string,
  prazoDias: number,
): ContratoCand[] {
  const seen = new Set<string>();
  const coletados: ContratoColetado[] = [];
  const placaNorm = compactPlaca(placaAlvo);

  function walk(dir: string): void {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p);
        continue;
      }
      if (!ent.isFile() || !/^Contrato.*\.docx$/i.test(ent.name)) continue;
      if (EXCL_PATH.test(p)) continue;
      const pastaContrato = path.dirname(p);
      if (seen.has(pastaContrato)) continue;
      const nomePasta = path.basename(pastaContrato);
      const inicioPasta = parseDataPasta(nomePasta);
      const cliente = clienteDaPasta(nomePasta);
      if (!inicioPasta || !cliente) continue;

      let texto = "";
      try {
        texto = docxPlainText(p);
      } catch {
        continue;
      }
      const placa = extrairPlacaDocx(texto);
      if (!placa || compactPlaca(placa) !== placaNorm) continue;

      seen.add(pastaContrato);
      const explicito = extrairPeriodoExplicito(texto);
      const inicio = explicito.inicio ?? inicioPasta;
      coletados.push({
        pastaContrato,
        docx: p,
        clienteNome: cliente,
        inicio,
        fimExplicito: explicito.fim,
        retorno: parseRetornoPasta(nomePasta, inicio),
        placa,
      });
    }
  }

  walk(root);

  // Fim efetivo de cada contrato = MENOR entre (devolução na pasta, início do
  // próximo contrato da placa, fim explícito do docx). Sem nenhum desses, usa
  // início + prazoDias. Assim cada locatário responde só pelo período em que
  // realmente teve o carro (inclui contratos já devolvidos).
  coletados.sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
  const out: ContratoCand[] = [];
  for (let i = 0; i < coletados.length; i++) {
    const c = coletados[i]!;
    const next = coletados[i + 1];
    const limites: number[] = [];
    if (c.retorno) limites.push(c.retorno.getTime());
    if (next) limites.push(next.inicio.getTime());
    if (c.fimExplicito) limites.push(c.fimExplicito.getTime());
    let fim =
      limites.length > 0
        ? new Date(Math.min(...limites))
        : addDiasLocal(c.inicio, prazoDias);
    if (fim.getTime() < c.inicio.getTime()) fim = addDiasLocal(c.inicio, prazoDias);

    if (data >= inicioDoDia(c.inicio) && data <= fim) {
      out.push({
        pastaContrato: c.pastaContrato,
        docx: c.docx,
        clienteNome: c.clienteNome,
        inicio: c.inicio,
        fim,
        placa: c.placa,
      });
    }
  }
  out.sort((a, b) => b.inicio.getTime() - a.inicio.getTime());
  return out;
}

export function inferirCondutorInfracao(
  placa: string,
  dataAutuacaoStr: string,
  prazoDias = 90,
): CondutorSugerido {
  const data = parseDataAutuacao(dataAutuacaoStr);
  if (!data) {
    return {
      condutorId: null,
      condutorContrato: null,
      clienteNome: null,
      aviso: `Data de autuação inválida: ${dataAutuacaoStr}`,
    };
  }

  const root = defaultContratosDir();
  const candidatos = listarContratosNaData(root, data, placa, prazoDias);
  if (candidatos.length === 0) {
    return {
      condutorId: null,
      condutorContrato: null,
      clienteNome: null,
      aviso: `Nenhum contrato ativo em ${dataAutuacaoStr} para placa ${formatPlacaHyphen(placa)}`,
    };
  }

  const escolhido = candidatos[0]!;
  let texto = "";
  try {
    texto = docxPlainText(escolhido.docx);
  } catch {
    /* use pasta only */
  }
  const cpf = extrairCpfDocx(texto);
  const clientes = loadClientes();
  const condutorId = resolveClienteId(clientes, cpf, escolhido.clienteNome);

  let aviso: string | null = null;
  if (!condutorId) {
    aviso = `Contrato sugere "${escolhido.clienteNome}" mas cliente não encontrado em clientes.json`;
  } else if (candidatos.length > 1) {
    aviso = `${candidatos.length} contratos na data; usado o mais recente: ${escolhido.clienteNome}`;
  }

  return {
    condutorId,
    condutorContrato: escolhido.pastaContrato,
    clienteNome: escolhido.clienteNome,
    aviso,
  };
}
