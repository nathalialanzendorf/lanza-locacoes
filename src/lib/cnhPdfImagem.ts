/**
 * Extrai JPEGs embutidos de PDF de CNH-e (SENATRAN costuma gravar a carteira como imagem).
 * Mesma lógica de `.cursor/tools/init-database/extrair-jpg-cnh.ts`.
 */
const MIN_JPEG_BYTES = 5000;

export function extrairJpegsEmbutidosPdf(buffer: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let i = 0;
  while (i < buffer.length - 1) {
    if (buffer[i] === 0xff && buffer[i + 1] === 0xd8) {
      let j = i + 2;
      while (j < buffer.length - 1 && !(buffer[j] === 0xff && buffer[j + 1] === 0xd9)) j++;
      if (j < buffer.length - 1) {
        const end = j + 2;
        const slice = buffer.subarray(i, end);
        if (slice.length >= MIN_JPEG_BYTES) out.push(Buffer.from(slice));
        i = end;
        continue;
      }
    }
    i++;
  }
  return out;
}

/** PNG embutido (alguns PDFs gov.br usam FlateDecode/PNG em vez de JPEG). */
export function extrairPngsEmbutidosPdf(buffer: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let i = 0;
  while (i < buffer.length - 12) {
    const idx = buffer.indexOf(sig, i);
    if (idx === -1) break;
    const iend = buffer.indexOf(Buffer.from("IEND"), idx + 8);
    if (iend === -1) break;
    const end = Math.min(iend + 8, buffer.length);
    const slice = buffer.subarray(idx, end);
    if (slice.length >= MIN_JPEG_BYTES) out.push(Buffer.from(slice));
    i = idx + 1;
  }
  return out;
}

/** JPEG + PNG embutidos no PDF. */
export function extrairImagensEmbutidasPdf(buffer: Buffer): Buffer[] {
  return [...extrairJpegsEmbutidosPdf(buffer), ...extrairPngsEmbutidosPdf(buffer)];
}

/** O JPEG maior costuma ser a página principal (CNH, fatura, etc.). */
export function escolherMaiorImagemEmbutida(buffers: Buffer[]): Buffer | null {
  if (!buffers.length) return null;
  return buffers.reduce((best, cur) => (cur.length > best.length ? cur : best));
}

/** @deprecated use escolherMaiorImagemEmbutida */
export const escolherImagemCnh = escolherMaiorImagemEmbutida;
