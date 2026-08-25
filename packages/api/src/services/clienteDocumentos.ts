import fs from "node:fs";
import path from "node:path";

import { editarClienteAsync } from "../lib-imports.js";
import { HttpError } from "../http.js";
import * as clientesService from "./clientes.js";
import * as documentos from "./documentos.js";

export type ClienteDocumentoTipo = "cnh" | "comprovante-residencia";

const TIPO_BLOB: Record<ClienteDocumentoTipo, string> = {
  cnh: "cliente-cnh",
  "comprovante-residencia": "cliente-comprovante-residencia",
};

function mimeFromFilename(nome: string): string {
  const ext = path.extname(nome).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".jpg" || ext === ".jpeg" || ext === ".jfif") return "image/jpeg";
  return "application/octet-stream";
}

function extensaoDocumento(nome: string): string {
  const ext = path.extname(nome).toLowerCase();
  return ext || ".pdf";
}

function normalizarTipo(raw: string): ClienteDocumentoTipo {
  const t = raw.trim().toLowerCase();
  if (t === "cnh" || t === "comprovante-residencia") return t;
  throw new HttpError(400, `Tipo inválido: ${raw}. Use cnh ou comprovante-residencia.`);
}

function storageFields(
  tipo: ClienteDocumentoTipo,
  storageKey: string,
  nome: string,
): Record<string, string> {
  if (tipo === "cnh") {
    return { cnhStorageKey: storageKey, cnhDocumentoNome: nome };
  }
  return { comprovanteStorageKey: storageKey, comprovanteDocumentoNome: nome };
}

function lerStorageCliente(
  cliente: Record<string, unknown>,
  tipo: ClienteDocumentoTipo,
): { key?: string; nome?: string; legadoPath?: string } {
  if (tipo === "cnh") {
    return {
      key: String(cliente.cnhStorageKey ?? "").trim() || undefined,
      nome: String(cliente.cnhDocumentoNome ?? "").trim() || undefined,
      legadoPath: String(cliente.cnhArquivo ?? "").trim() || undefined,
    };
  }
  return {
    key: String(cliente.comprovanteStorageKey ?? "").trim() || undefined,
    nome: String(cliente.comprovanteDocumentoNome ?? "").trim() || undefined,
  };
}

export async function uploadClienteDocumento(
  clienteId: string,
  tipoRaw: string,
  buffer: Buffer,
  opts: { nomeArquivo: string; contentType?: string },
) {
  const tipo = normalizarTipo(tipoRaw);
  const id = clienteId.trim();
  const cliente = await clientesService.obterClienteAsync(id);
  if (!cliente) throw new HttpError(404, "Cliente não encontrado");
  if (!buffer.length) throw new HttpError(400, "Arquivo vazio");

  const nome = opts.nomeArquivo?.trim() || (tipo === "cnh" ? "cnh.pdf" : "comprovante.pdf");
  const ext = extensaoDocumento(nome);
  const stored = await documentos.enviarDocumentoBinario({
    pathname: `clientes/${id}/${tipo}${ext}`,
    conteudo: buffer,
    contentType: opts.contentType?.trim() || mimeFromFilename(nome),
    tipo: TIPO_BLOB[tipo],
    clienteId: id,
  });

  const patch = storageFields(tipo, stored.pathname, nome);
  const atualizado = await editarClienteAsync(id, patch);
  if (!atualizado) throw new HttpError(404, "Cliente não encontrado");
  return { cliente: atualizado, documento: { tipo, storageKey: stored.pathname, nome } };
}

export async function downloadClienteDocumento(
  clienteId: string,
  tipoRaw: string,
): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  const tipo = normalizarTipo(tipoRaw);
  const cliente = await clientesService.obterClienteAsync(clienteId.trim());
  if (!cliente) throw new HttpError(404, "Cliente não encontrado");

  const c = cliente as Record<string, unknown>;
  const meta = lerStorageCliente(c, tipo);
  if (meta.key) {
    const buf = await documentos.lerDocumentoBytes(meta.key);
    if (!buf?.length) throw new HttpError(404, "Documento não encontrado no armazenamento");
    const blob = await documentos.obterDocumento(meta.key);
    const filename =
      meta.nome ||
      (tipo === "cnh" ? "cnh.pdf" : "comprovante-residencia.pdf");
    return {
      buffer: buf,
      contentType: blob?.contentType ?? mimeFromFilename(filename),
      filename,
    };
  }

  if (tipo === "cnh" && meta.legadoPath && fs.existsSync(meta.legadoPath)) {
    const filename = path.basename(meta.legadoPath);
    return {
      buffer: fs.readFileSync(meta.legadoPath),
      contentType: mimeFromFilename(filename),
      filename,
    };
  }

  throw new HttpError(404, tipo === "cnh" ? "CNH não enviada" : "Comprovante não enviado");
}

export function clienteTemDocumento(
  cliente: Record<string, unknown>,
  tipo: ClienteDocumentoTipo,
): boolean {
  const meta = lerStorageCliente(cliente, tipo);
  if (meta.key) return true;
  if (tipo === "cnh" && meta.legadoPath && fs.existsSync(meta.legadoPath)) return true;
  return false;
}
