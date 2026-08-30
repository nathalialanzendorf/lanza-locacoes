import {
  blobAccess,
  blobReadWriteToken,
  blobStoreId,
  isBlobConfigured,
  isReadOnlyServerlessFs,
  storagePrefix,
} from "./config.js";
import { blobKey } from "./paths.js";
import {
  deleteLocalMirror,
  getLocalMirror,
  listLocalMirror,
  localMirrorEnabled,
  putLocalMirror,
} from "./localStore.js";
import type { ListBlobsResult, StoredBlob } from "./types.js";

type BlobModule = typeof import("@vercel/blob");

let blobModulePromise: Promise<BlobModule> | null = null;

async function blobModule(): Promise<BlobModule> {
  if (!blobModulePromise) {
    blobModulePromise = import("@vercel/blob");
  }
  return blobModulePromise;
}

function blobAuthOpts<T extends Record<string, unknown>>(
  opts: T,
): T & { token?: string; storeId?: string } {
  const token = blobReadWriteToken();
  const storeId = blobStoreId();
  return {
    ...opts,
    ...(token ? { token } : {}),
    ...(storeId ? { storeId } : {}),
  };
}

function blobPathCandidates(pathname: string): string[] {
  const raw = pathname.trim();
  if (!raw) return [];
  const out = new Set<string>([raw]);
  const prefixed = blobKey(raw);
  if (prefixed !== raw) out.add(prefixed);
  const prefix = `${storagePrefix()}/`;
  if (raw.startsWith(prefix)) out.add(raw.slice(prefix.length));
  return [...out];
}

function bodyByteLength(body: Buffer | string): number {
  return typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.length;
}

export async function putBytes(
  pathname: string,
  body: Buffer | string,
  opts?: { contentType?: string; allowOverwrite?: boolean },
): Promise<StoredBlob> {
  const contentType = opts?.contentType;
  if (isBlobConfigured()) {
    const { put } = await blobModule();
    const result = await put(pathname, body, blobAuthOpts({
      access: blobAccess(),
      contentType,
      addRandomSuffix: false,
      allowOverwrite: opts?.allowOverwrite === true,
    }));
    return {
      pathname: result.pathname,
      url: result.url,
      downloadUrl: result.downloadUrl,
      size: bodyByteLength(body),
      uploadedAt: new Date().toISOString(),
      contentType: result.contentType,
      backend: "vercel-blob",
    };
  }
  if (localMirrorEnabled()) {
    return putLocalMirror(pathname, body, contentType);
  }
  if (isReadOnlyServerlessFs()) {
    throw new Error(
      "Blob não configurado na Vercel. Crie um Blob Store no projeto (Storage → Blob) e redeploy.",
    );
  }
  throw new Error("Armazenamento não configurado (Blob ou espelho local)");
}

export async function putText(
  pathname: string,
  text: string,
  opts?: { contentType?: string; allowOverwrite?: boolean },
): Promise<StoredBlob> {
  return putBytes(pathname, text, {
    contentType: opts?.contentType ?? "text/plain; charset=utf-8",
    allowOverwrite: opts?.allowOverwrite,
  });
}

export async function putJson(
  pathname: string,
  data: unknown,
  opts?: { allowOverwrite?: boolean },
): Promise<StoredBlob> {
  return putText(pathname, JSON.stringify(data, null, 2), {
    contentType: "application/json; charset=utf-8",
    allowOverwrite: opts?.allowOverwrite,
  });
}

async function fetchBlobByPathname(pathname: string): Promise<Buffer | null> {
  const { get, head } = await blobModule();
  const auth = blobAuthOpts({ access: blobAccess() });

  for (const candidate of blobPathCandidates(pathname)) {
    try {
      const result = await get(candidate, auth);
      if (result?.statusCode === 200 && result.stream) {
        const buf = Buffer.from(await new Response(result.stream).arrayBuffer());
        if (buf.length) return buf;
      }
    } catch {
      /* tenta candidato seguinte */
    }

    try {
      const meta = await head(candidate, auth);
      if (meta?.downloadUrl) {
        const res = await fetch(meta.downloadUrl);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length) return buf;
        }
      }
    } catch {
      /* tenta candidato seguinte */
    }
  }

  return null;
}

export async function getBytes(pathname: string): Promise<Buffer | null> {
  if (isBlobConfigured()) {
    return fetchBlobByPathname(pathname);
  }
  if (localMirrorEnabled()) {
    for (const candidate of blobPathCandidates(pathname)) {
      const buf = await getLocalMirror(candidate);
      if (buf?.length) return buf;
    }
  }
  return null;
}

export async function getText(pathname: string): Promise<string | null> {
  const buf = await getBytes(pathname);
  return buf ? buf.toString("utf8") : null;
}

export async function listBlobs(opts: {
  prefix?: string;
  limit?: number;
  cursor?: string;
}): Promise<ListBlobsResult> {
  if (isBlobConfigured()) {
    const { list } = await blobModule();
    const result = await list(blobAuthOpts({
      prefix: opts.prefix,
      limit: opts.limit ?? 100,
      cursor: opts.cursor,
    }));
    return {
      blobs: result.blobs.map((b) => ({
        pathname: b.pathname,
        url: b.url,
        downloadUrl: b.downloadUrl,
        size: b.size,
        uploadedAt: b.uploadedAt.toISOString(),
        backend: "vercel-blob" as const,
      })),
      cursor: result.cursor,
      hasMore: result.hasMore,
    };
  }
  if (localMirrorEnabled()) {
    return listLocalMirror({ prefix: opts.prefix, limit: opts.limit });
  }
  return { blobs: [], hasMore: false };
}

export async function deleteBlob(pathname: string): Promise<boolean> {
  if (isBlobConfigured()) {
    const { del } = await blobModule();
    const listed = await listBlobs({ prefix: pathname, limit: 1 });
    const hit = listed.blobs.find((b) => b.pathname === pathname);
    if (!hit) return false;
    await del(hit.url, blobAuthOpts({}));
    return true;
  }
  if (localMirrorEnabled()) return deleteLocalMirror(pathname);
  return false;
}

export async function headBlob(pathname: string): Promise<StoredBlob | null> {
  if (isBlobConfigured()) {
    const { head } = await blobModule();
    const auth = blobAuthOpts({ access: blobAccess() });
    for (const candidate of blobPathCandidates(pathname)) {
      try {
        const meta = await head(candidate, auth);
        if (!meta?.pathname) continue;
        return {
          pathname: meta.pathname,
          url: meta.url,
          downloadUrl: meta.downloadUrl,
          size: meta.size,
          uploadedAt: meta.uploadedAt.toISOString(),
          contentType: meta.contentType,
          backend: "vercel-blob",
        };
      } catch {
        /* tenta candidato seguinte */
      }
    }
    return null;
  }
  if (localMirrorEnabled()) {
    for (const candidate of blobPathCandidates(pathname)) {
      const buf = await getLocalMirror(candidate);
      if (buf?.length) {
        return {
          pathname: candidate,
          url: candidate,
          size: buf.length,
          uploadedAt: new Date().toISOString(),
          backend: "local-mirror",
        };
      }
    }
  }
  return null;
}
