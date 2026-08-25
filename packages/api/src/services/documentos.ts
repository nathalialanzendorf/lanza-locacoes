import fs from "node:fs";
import path from "node:path";

import {
  blobKey,
  deleteBlob,
  getBytes,
  getText,
  headBlob,
  isBlobConfigured,
  isStorageActive,
  listBlobs,
  localMirrorRoot,
  mirrorLocalFilesToBlob,
  putBytes,
  putText,
  storagePrefix,
  type MirrorLocalFilesResult,
  type StoredBlob,
} from "../lib-imports.js";
import { getDbBackend, pgQuery } from "@lanza/db";

import { HttpError } from "../http.js";

export function statusDocumentos() {
  return {
    ativo: isStorageActive(),
    backend: isBlobConfigured() ? "vercel-blob" : localMirrorRoot() ? "local-mirror" : "desativado",
    prefix: storagePrefix(),
    localMirror: localMirrorRoot(),
  };
}

export async function listarDocumentos(query: {
  prefix?: string;
  limit?: number;
  cursor?: string;
}): Promise<{ blobs: StoredBlob[]; cursor?: string; hasMore: boolean }> {
  if (!isStorageActive()) {
    throw new HttpError(
      503,
      process.env.VERCEL
        ? "Armazenamento Blob não configurado na Vercel — crie um Blob Store e defina BLOB_READ_WRITE_TOKEN."
        : "Armazenamento Blob não configurado",
    );
  }
  const prefix = query.prefix?.trim();
  const fullPrefix = prefix ? blobKey(prefix) : storagePrefix();
  return listBlobs({
    prefix: fullPrefix,
    limit: query.limit ?? 50,
    cursor: query.cursor,
  });
}

export async function obterDocumento(pathname: string): Promise<StoredBlob | null> {
  if (!isStorageActive()) return null;
  const key = pathname.includes("/") ? pathname : blobKey(pathname);
  return headBlob(key);
}

export async function lerDocumentoTexto(pathname: string): Promise<string | null> {
  const key = pathname.includes("/") ? pathname : blobKey(pathname);
  return getText(key);
}

export async function lerDocumentoBytes(pathname: string): Promise<Buffer | null> {
  const key = pathname.includes("/") ? pathname : blobKey(pathname);
  return getBytes(key);
}

export async function enviarDocumento(input: {
  pathname: string;
  conteudo: string;
  contentType?: string;
  tipo?: string;
  clienteId?: string;
  placa?: string;
}): Promise<StoredBlob> {
  if (!isStorageActive()) {
    throw new HttpError(
      503,
      process.env.VERCEL
        ? "Armazenamento Blob não configurado na Vercel — crie um Blob Store e defina BLOB_READ_WRITE_TOKEN."
        : "Armazenamento Blob não configurado",
    );
  }
  const key = input.pathname.startsWith(storagePrefix())
    ? input.pathname
    : blobKey(input.pathname);
  const stored = await putText(key, input.conteudo, {
    contentType: input.contentType,
    allowOverwrite: true,
  });
  await gravarMetadadoBestEffort({
    storageKey: stored.pathname,
    tipo: input.tipo ?? "documento",
    nome: path.basename(stored.pathname),
    mime: stored.contentType,
    bytes: stored.size,
    clienteId: input.clienteId,
    placa: input.placa,
  });
  return stored;
}

export async function enviarDocumentoBinario(input: {
  pathname: string;
  conteudo: Buffer;
  contentType?: string;
  tipo?: string;
  clienteId?: string;
  placa?: string;
}): Promise<StoredBlob> {
  if (!isStorageActive()) {
    throw new HttpError(
      503,
      process.env.VERCEL
        ? "Armazenamento Blob não configurado na Vercel — crie um Blob Store e defina BLOB_READ_WRITE_TOKEN."
        : "Armazenamento Blob não configurado",
    );
  }
  const key = input.pathname.startsWith(storagePrefix())
    ? input.pathname
    : blobKey(input.pathname);
  const stored = await putBytes(key, input.conteudo, {
    contentType: input.contentType,
    allowOverwrite: true,
  });
  await gravarMetadadoBestEffort({
    storageKey: stored.pathname,
    tipo: input.tipo ?? "documento",
    nome: path.basename(stored.pathname),
    mime: stored.contentType,
    bytes: stored.size,
    clienteId: input.clienteId,
    placa: input.placa,
  });
  return stored;
}

export async function removerDocumento(pathname: string): Promise<boolean> {
  if (!isStorageActive()) {
    throw new HttpError(
      503,
      process.env.VERCEL
        ? "Armazenamento Blob não configurado na Vercel — crie um Blob Store e defina BLOB_READ_WRITE_TOKEN."
        : "Armazenamento Blob não configurado",
    );
  }
  const key = pathname.includes("/") ? pathname : blobKey(pathname);
  const ok = await deleteBlob(key);
  if (ok && getDbBackend() !== "file") {
    try {
      await pgQuery("DELETE FROM lanza.documentos WHERE storage_key = $1", [key]);
    } catch {
      /* metadados opcionais */
    }
  }
  return ok;
}

export async function espelharArquivosLocais(
  files: string[],
  categoria: string,
): Promise<MirrorLocalFilesResult> {
  const result = await mirrorLocalFilesToBlob(files, categoria);
  for (const blob of result.uploaded) {
    await gravarMetadadoBestEffort({
      storageKey: blob.pathname,
      tipo: categoria,
      nome: path.basename(blob.pathname),
      mime: blob.contentType,
      bytes: blob.size,
    });
  }
  return result;
}

async function gravarMetadadoBestEffort(meta: {
  storageKey: string;
  tipo: string;
  nome: string;
  mime?: string;
  bytes?: number;
  clienteId?: string;
  placa?: string;
  pacoteId?: string;
}): Promise<void> {
  if (getDbBackend() === "file") return;
  try {
    await pgQuery(
      `INSERT INTO lanza.documentos (storage_key, tipo, nome, mime, bytes, cliente_id, placa, pacote_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (storage_key) DO UPDATE SET
         tipo = EXCLUDED.tipo,
         nome = EXCLUDED.nome,
         mime = EXCLUDED.mime,
         bytes = EXCLUDED.bytes,
         cliente_id = COALESCE(EXCLUDED.cliente_id, lanza.documentos.cliente_id),
         placa = COALESCE(EXCLUDED.placa, lanza.documentos.placa),
         pacote_id = COALESCE(EXCLUDED.pacote_id, lanza.documentos.pacote_id)`,
      [
        meta.storageKey,
        meta.tipo,
        meta.nome,
        meta.mime ?? null,
        meta.bytes ?? null,
        meta.clienteId ?? null,
        meta.placa ?? null,
        meta.pacoteId ?? null,
      ],
    );
  } catch {
    /* tabela pode não existir ainda */
  }
}

/** Coleta caminhos de ficheiros existentes. */
export function filtrarArquivosExistentes(paths: Array<string | undefined | null>): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (!p?.trim()) continue;
    const abs = path.resolve(p);
    if (fs.existsSync(abs)) out.push(abs);
  }
  return out;
}
