import path from "node:path";
import fs from "node:fs";

import {
  REPO_ROOT,
  ativarClienteDoContrato,
  atualizarContratoDbAsync,
  desativarClienteDoContrato,
  encerrarContratoDbAsync,
  encerrarContratoAtivoParaRenovarAsync,
  excluirContratoAsync,
  gerar,
  gerarDespesasIniciaisContratoAsync,
  ensurePdfFromDocx,
  montarDadosContratoFromDbAsync,
  nomeArquivoContratoComExtensao,
  registrarContratoFromDadosAsync,
  validarModoContratoAsync,
  type ContratoRegistro,
  type GerarContratoDados,
  type MontarContratoDbInput,
  type MotivoEncerramento,
} from "../lib-imports.js";
import { hasContratoAssinadoColumns, hasDocumentoGeradoColumns } from "@lanza/db";
import { HttpError } from "../http.js";
import * as contratosService from "./contratos.js";
import * as documentos from "./documentos.js";
import { mimeFromFilename } from "@lanza/storage";

function absRepo(p: string | undefined): string | undefined {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p);
}

function normalizePaths(dados: GerarContratoDados): void {
  for (const k of ["template", "contratosDir", "cnhArquivo"] as const) {
    if (dados[k]) {
      (dados as unknown as Record<string, string | undefined>)[k] = absRepo(dados[k] as string);
    }
  }
  if (process.env.VERCEL) {
    dados.contratosDir = path.join("/tmp", "lanza-contratos");
  }
}

export type ContratoCriarRenovarInput = GerarContratoDados | MontarContratoDbInput;

const CONTRATO_REQUEST_TIMEOUT_MS = 30_000;
const POS_SAVE_TIMEOUT_MS = 10_000;
const CONTRATO_GRAVAR_TIMEOUT_MS = CONTRATO_REQUEST_TIMEOUT_MS - POS_SAVE_TIMEOUT_MS;

class StepTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} excedeu ${Math.round(ms / 1000)}s`);
    this.name = "StepTimeoutError";
  }
}

async function withStepTimeout<T>(label: string, ms: number, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new StepTimeoutError(label, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function posSaveContratoCriar(
  reg: ContratoRegistro,
  dados: GerarContratoDados,
  montarInput: MontarContratoDbInput | null,
): Promise<{
  clienteStatus: Awaited<ReturnType<typeof ativarClienteDoContrato>> | null;
  despesasIniciais: Awaited<ReturnType<typeof gerarDespesasIniciaisContratoAsync>> | null;
  aviso: string | null;
}> {
  let clienteStatus: Awaited<ReturnType<typeof ativarClienteDoContrato>> | null = null;
  let despesasIniciais: Awaited<ReturnType<typeof gerarDespesasIniciaisContratoAsync>> | null =
    null;
  const avisos: string[] = [];

  await Promise.all([
    ativarClienteDoContrato({
      clienteId: reg.clienteId,
      cpf: reg.cpf,
      nome: reg.clienteNome,
      placa: reg.placa,
      veiculoId: reg.veiculoId,
    })
      .then((r) => {
        clienteStatus = r;
      })
      .catch((err) => {
        avisos.push(
          `vínculo cliente/veículo: ${err instanceof Error ? err.message : String(err)}`,
        );
      }),
    gerarDespesasIniciaisContratoAsync(reg, dados, montarInput)
      .then((r) => {
        despesasIniciais = r;
      })
      .catch((err) => {
        avisos.push(
          `despesas iniciais: ${err instanceof Error ? err.message : String(err)}`,
        );
      }),
  ]);

  return {
    clienteStatus,
    despesasIniciais,
    aviso: avisos.length ? avisos.join("; ") : null,
  };
}

function montarInputFromRegistro(reg: ContratoRegistro): MontarContratoDbInput {
  return {
    veiculoId: reg.veiculoId,
    placa: reg.placa,
    clienteId: reg.clienteId ?? undefined,
    cpf: reg.cpf ?? undefined,
    clienteNome: reg.clienteNome,
    semana: reg.valorSemanal ?? 0,
    caucao: reg.valorCaucao ?? 0,
    diaria: reg.valorDiaria ?? undefined,
    mensal: reg.valorMensal ?? undefined,
    tipoContrato: reg.tipoContrato,
    inicio: reg.dataInicio,
    hora: reg.horaInicio ?? "18:00",
    dias: reg.prazoDias ?? undefined,
    diaPagamento: reg.diaPagamentoTexto ?? reg.diaPagamentoSemana ?? undefined,
  };
}

async function montarDadosContratoFromRegistroAsync(
  reg: ContratoRegistro,
): Promise<GerarContratoDados> {
  return montarDadosContratoFromDbAsync(montarInputFromRegistro(reg));
}

export async function criarContrato(input: ContratoCriarRenovarInput) {
  return executarContratoModo("criar", input);
}

export async function renovarContrato(input: ContratoCriarRenovarInput) {
  return executarContratoModo("renovar", input);
}

async function executarContratoModo(
  modo: "criar" | "renovar",
  input: ContratoCriarRenovarInput,
) {
  let dados: GerarContratoDados;

  try {
    if ("veiculoId" in input && input.veiculoId && "semana" in input && input.semana != null) {
      dados = await montarDadosContratoFromDbAsync(input as MontarContratoDbInput);
    } else if ("placa" in input && input.placa && "semana" in input && input.semana != null) {
      dados = await montarDadosContratoFromDbAsync(input as MontarContratoDbInput);
    } else {
      dados = input as GerarContratoDados;
    }
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }
  normalizePaths(dados);

  const placa = dados.veiculo?.placa?.trim() || undefined;
  const clienteNome = dados.cliente?.nome ?? "";
  const veiculoIdFiltro =
    "veiculoId" in input && input.veiculoId ? String(input.veiculoId).trim() : undefined;
  if (!placa && !veiculoIdFiltro) {
    throw new HttpError(400, "Veículo não informado — informe veiculoId ou placa cadastrada");
  }

  const clienteIdFiltro =
    "clienteId" in input && input.clienteId ? String(input.clienteId).trim() : undefined;
  const contratoRenovarId =
    "contratoRenovarId" in input && input.contratoRenovarId
      ? String(input.contratoRenovarId).trim()
      : undefined;

  const filtrosContrato = {
    placa: placa ?? "",
    veiculoId: veiculoIdFiltro,
    cpf: clienteIdFiltro ? null : dados.cliente?.cpf ?? null,
    clienteNome,
    clienteId: clienteIdFiltro,
    contratoRenovarId,
  };

  let contratoEncerrado = null;
  if (modo === "renovar") {
    try {
      contratoEncerrado = await encerrarContratoAtivoParaRenovarAsync(
        filtrosContrato,
        dados.prazo.inicio,
      );
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
  }

  let proximaVersao: number;
  let contratoAnteriorId: string | null | undefined;
  try {
    ({ proximaVersao, contratoAnteriorId } = await validarModoContratoAsync(modo, filtrosContrato));
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : String(err));
  }

  let reg = null;
  try {
    reg = await withStepTimeout("Gravação do contrato", CONTRATO_GRAVAR_TIMEOUT_MS, () =>
      registrarContratoFromDadosAsync(dados, {
        ...(contratoAnteriorId
          ? { contratoAnteriorId, versao: proximaVersao }
          : proximaVersao > 1
            ? { versao: proximaVersao }
            : {}),
      }),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof StepTimeoutError || /connection terminated|connection timeout|timeout expired/i.test(msg)) {
      throw new HttpError(
        504,
        "Ligação ao PostgreSQL expirou. Tente novamente em alguns segundos — o contrato pode ter sido salvo.",
      );
    }
    throw new HttpError(500, msg);
  }

  let clienteStatus = null;
  let despesasIniciais = null;
  let despesasIniciaisAviso: string | null = null;
  if (modo === "criar" && reg) {
    const montarInput =
      "placa" in input && input.placa && "semana" in input && input.semana != null
        ? (input as MontarContratoDbInput)
        : "veiculoId" in input && input.veiculoId && "semana" in input && input.semana != null
          ? (input as MontarContratoDbInput)
          : null;
    try {
      const pos = await withStepTimeout("Pós-gravação do contrato", POS_SAVE_TIMEOUT_MS, () =>
        posSaveContratoCriar(reg, dados, montarInput),
      );
      clienteStatus = pos.clienteStatus;
      despesasIniciais = pos.despesasIniciais;
      despesasIniciaisAviso = pos.aviso;
    } catch (err) {
      despesasIniciaisAviso =
        err instanceof StepTimeoutError
          ? "Contrato salvo. Vínculo e despesas iniciais não concluíram a tempo — recarregue a lista ou gere as despesas manualmente."
          : err instanceof Error
            ? err.message
            : String(err);
      console.error("[contratos] falha pós-gravação:", despesasIniciaisAviso);
    }
  }

  return {
    modo,
    proximaVersao,
    contrato: reg,
    contratoEncerrado,
    clienteStatus,
    despesasIniciais,
    despesasIniciaisAviso,
    documento: null,
  };
}

export type GerarDocumentoContratoResult = {
  contratoId: string;
  pasta: string;
  docx: string;
  pdf: string | null;
  cnh: string | null;
  clienteNome: string;
  documentoDocxStorageKey?: string | null;
  documentoPdfStorageKey?: string | null;
  documentoGeradoEm?: string | null;
};

async function persistDocumentoGeradoContrato(
  contratoId: string,
  gerado: Omit<GerarDocumentoContratoResult, "documentoDocxStorageKey" | "documentoPdfStorageKey" | "documentoGeradoEm">,
): Promise<Pick<GerarDocumentoContratoResult, "documentoDocxStorageKey" | "documentoPdfStorageKey" | "documentoGeradoEm">> {
  if (!(await hasDocumentoGeradoColumns())) {
    throw new HttpError(
      503,
      "Armazenamento de documento gerado indisponível — execute a migration 027_cliente_contrato_documentos_storage.sql.",
    );
  }
  if (!fs.existsSync(gerado.docx)) {
    throw new HttpError(500, "Falha ao gerar Word do contrato.");
  }

  const docxBuf = fs.readFileSync(gerado.docx);
  const docxStored = await documentos.enviarDocumentoBinario({
    pathname: `contratos/${contratoId.trim()}/gerado.docx`,
    conteudo: docxBuf,
    contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    tipo: "contrato-gerado-docx",
  });

  let pdfStored: { pathname: string } | null = null;
  if (gerado.pdf && fs.existsSync(gerado.pdf)) {
    pdfStored = await documentos.enviarDocumentoBinario({
      pathname: `contratos/${contratoId.trim()}/gerado.pdf`,
      conteudo: fs.readFileSync(gerado.pdf),
      contentType: "application/pdf",
      tipo: "contrato-gerado-pdf",
    });
  }

  const geradoEm = new Date().toISOString();
  const geradoNome = nomeArquivoContratoComExtensao(
    gerado.clienteNome || "Cliente",
    "docx",
  ).replace(/\.docx$/i, "");

  await atualizarContratoDbAsync(contratoId, {
    documentoDocxStorageKey: docxStored.pathname,
    documentoPdfStorageKey: pdfStored?.pathname ?? null,
    documentoGeradoEm: geradoEm,
    documentoGeradoNome: geradoNome,
  });

  return {
    documentoDocxStorageKey: docxStored.pathname,
    documentoPdfStorageKey: pdfStored?.pathname ?? null,
    documentoGeradoEm: geradoEm,
  };
}

/** Gera Word/PDF a partir do registro já gravado no banco. */
export async function gerarDocumentoContrato(contratoId: string): Promise<GerarDocumentoContratoResult> {
  const reg = await contratosService.obterContratoAsync(contratoId);
  if (!reg) throw new HttpError(404, "Contrato não encontrado");
  const dados = await montarDadosContratoFromRegistroAsync(reg);
  normalizePaths(dados);
  const gerado = gerar(dados);
  if (!gerado.pdf && gerado.docx) {
    const pdfPath = gerado.docx.replace(/\.docx$/i, ".pdf");
    if (await ensurePdfFromDocx(gerado.docx, pdfPath)) {
      gerado.pdf = pdfPath;
    }
  }
  const base: GerarDocumentoContratoResult = {
    contratoId: reg.id,
    pasta: gerado.pasta,
    docx: gerado.docx,
    pdf: gerado.pdf,
    cnh: gerado.cnh,
    clienteNome: reg.clienteNome?.trim() || dados.cliente?.nome?.trim() || "",
  };
  const stored = await persistDocumentoGeradoContrato(reg.id, base);
  return { ...base, ...stored };
}

export async function downloadDocumentoGeradoContrato(
  contratoId: string,
  formato: "docx" | "pdf",
): Promise<DocumentoDownload> {
  const contrato = await contratosService.obterContratoAsync(contratoId.trim());
  if (!contrato) throw new HttpError(404, "Contrato não encontrado");

  const key =
    formato === "pdf"
      ? contrato.documentoPdfStorageKey?.trim()
      : contrato.documentoDocxStorageKey?.trim();
  if (!key) {
    throw new HttpError(
      404,
      formato === "pdf"
        ? "PDF ainda não gerado — use «Gerar nova versão» primeiro."
        : "Word ainda não gerado — use «Gerar nova versão» primeiro.",
    );
  }

  const buf = await documentos.lerDocumentoBytes(key);
  if (!buf?.length) {
    throw new HttpError(404, "Arquivo do contrato não encontrado no armazenamento.");
  }

  const blob = await documentos.obterDocumento(key);
  const nomeBase =
    contrato.documentoGeradoNome?.trim() ||
    contrato.clienteNome?.trim() ||
    "Contrato";
  const filename = nomeArquivoContratoComExtensao(nomeBase.replace(/^Contrato\s*-\s*/i, ""), formato);
  const contentType =
    formato === "pdf"
      ? "application/pdf"
      : blob?.contentType ??
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  return { buffer: buf, filename, contentType };
}

export type DocumentoDownload = {
  buffer: Buffer;
  filename: string;
  contentType: string;
};

export function resolverDownloadDocumentoContrato(
  gerado: GerarDocumentoContratoResult,
  formato: "docx" | "pdf",
): DocumentoDownload {
  const filePath = formato === "pdf" ? gerado.pdf : gerado.docx;
  if (!filePath || !fs.existsSync(filePath)) {
    throw new HttpError(
      404,
      formato === "pdf"
        ? "PDF não disponível — a conversão falhou. Tente baixar o Word (.docx)."
        : "Documento Word não encontrado.",
    );
  }
  const buffer = fs.readFileSync(filePath);
  const filename = nomeArquivoContratoComExtensao(
    gerado.clienteNome || "Cliente",
    formato,
  );
  const contentType =
    formato === "pdf"
      ? "application/pdf"
      : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return { buffer, filename, contentType };
}

export type ContratoEncerrarInput = {
  idOuPasta: string;
  dataEncerramento: string;
  motivoEncerramento: MotivoEncerramento;
  quebraContrato?: boolean;
};

export async function encerrarContrato(input: ContratoEncerrarInput) {
  const quebra =
    input.quebraContrato ?? (input.motivoEncerramento === "troca" ? false : true);
  const r = await encerrarContratoDbAsync(input.idOuPasta, {
    dataEncerramento: input.dataEncerramento,
    motivoEncerramento: input.motivoEncerramento,
    quebraContrato: quebra,
  });
  const clienteStatus = await desativarClienteDoContrato({
    clienteId: r.clienteId,
    cpf: r.cpf,
    nome: r.clienteNome,
    placa: r.placa,
    veiculoId: r.veiculoId,
    contratoId: r.id,
  });
  return { contrato: r, clienteStatus };
}

export async function removerContrato(idOuPasta: string) {
  try {
    return await excluirContratoAsync(idOuPasta);
  } catch (err) {
    throw new HttpError(404, err instanceof Error ? err.message : String(err));
  }
}

export type ContratoAtualizarInput = {
  dataInicio?: string;
  horaInicio?: string;
  dataFimPrevista?: string;
  prazoDias?: number;
  dataEncerramento?: string | null;
  motivoEncerramento?: MotivoEncerramento | null;
  quebraContrato?: boolean;
  status?: "ativo" | "encerrado";
  tipoContrato?: "semanal" | "diaria" | "mensal";
  diaPagamentoSemana?: string | null;
  diaPagamentoMes?: number | null;
  diaPagamentoTexto?: string | null;
  valorSemanal?: number | null;
  valorMensal?: number | null;
  valorDiaria?: number | null;
  valorCaucao?: number;
  contratoAssinado?: {
    nomeArquivo: string;
    conteudoBase64: string;
    contentType?: string;
  };
};

export async function atualizarContrato(id: string, input: ContratoAtualizarInput) {
  try {
    const patch: Parameters<typeof atualizarContratoDbAsync>[1] = {
      dataInicio: input.dataInicio,
      horaInicio: input.horaInicio,
      dataFimPrevista: input.dataFimPrevista,
      prazoDias: input.prazoDias,
      dataEncerramento: input.dataEncerramento,
      motivoEncerramento: input.motivoEncerramento,
      quebraContrato: input.quebraContrato,
      status: input.status,
      tipoContrato: input.tipoContrato,
      diaPagamentoSemana: input.diaPagamentoSemana,
      diaPagamentoMes: input.diaPagamentoMes,
      diaPagamentoTexto: input.diaPagamentoTexto,
      valorSemanal: input.valorSemanal,
      valorMensal: input.valorMensal,
      valorDiaria: input.valorDiaria,
      valorCaucao: input.valorCaucao,
    };

    if (input.contratoAssinado?.conteudoBase64?.trim()) {
      const uploaded = await persistContratoAssinadoBytes(id, {
        nomeArquivo: input.contratoAssinado.nomeArquivo,
        buffer: Buffer.from(input.contratoAssinado.conteudoBase64, "base64"),
        contentType: input.contratoAssinado.contentType,
      });
      patch.contratoAssinadoStorageKey = uploaded.storageKey;
      patch.contratoAssinadoNome = uploaded.nome;
    }

    const contrato = await atualizarContratoDbAsync(id, patch);
    return { contrato };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (/Upload de contrato assinado indisponível/i.test(msg)) {
      throw new HttpError(503, msg);
    }
    throw new HttpError(404, msg);
  }
}

async function persistContratoAssinadoBytes(
  id: string,
  input: { nomeArquivo?: string; buffer: Buffer; contentType?: string },
): Promise<{ storageKey: string; nome: string }> {
  if (!(await hasContratoAssinadoColumns())) {
    throw new HttpError(
      503,
      "Upload de contrato assinado indisponível — execute a migration 017_contrato_assinado.sql no PostgreSQL.",
    );
  }
  const nome = input.nomeArquivo?.trim() || "contrato-assinado.pdf";
  if (!input.buffer.length) {
    throw new HttpError(400, "Arquivo do contrato assinado vazio");
  }
  const ext = path.extname(nome) || ".pdf";
  const stored = await documentos.enviarDocumentoBinario({
    pathname: `contratos/${id.trim()}/assinado${ext}`,
    conteudo: input.buffer,
    contentType: input.contentType?.trim() || mimeFromFilename(nome),
    tipo: "contrato-assinado",
  });
  return { storageKey: stored.pathname, nome };
}

export async function uploadContratoAssinado(
  id: string,
  buffer: Buffer,
  opts: { nomeArquivo: string; contentType?: string },
) {
  try {
    const uploaded = await persistContratoAssinadoBytes(id, {
      nomeArquivo: opts.nomeArquivo,
      buffer,
      contentType: opts.contentType,
    });
    const contrato = await atualizarContratoDbAsync(id, {
      contratoAssinadoStorageKey: uploaded.storageKey,
      contratoAssinadoNome: uploaded.nome,
    });
    return { contrato };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (/Upload de contrato assinado indisponível/i.test(msg)) {
      throw new HttpError(503, msg);
    }
    throw new HttpError(404, msg);
  }
}

export async function downloadContratoAssinado(id: string): Promise<{
  buffer: Buffer;
  contentType: string;
  filename: string;
}> {
  const contrato = await contratosService.obterContratoAsync(id.trim());
  if (!contrato) {
    throw new HttpError(404, "Contrato não encontrado");
  }
  const key = contrato.contratoAssinadoStorageKey?.trim();
  if (!key) {
    throw new HttpError(404, "Este contrato não tem arquivo assinado");
  }
  const buf = await documentos.lerDocumentoBytes(key);
  if (!buf?.length) {
    throw new HttpError(404, "Arquivo do contrato assinado não encontrado");
  }
  const blob = await documentos.obterDocumento(key);
  const nome = contrato.contratoAssinadoNome?.trim() || path.basename(key) || "contrato-assinado.pdf";
  return {
    buffer: buf,
    contentType: blob?.contentType ?? mimeFromFilename(nome),
    filename: nome,
  };
}
