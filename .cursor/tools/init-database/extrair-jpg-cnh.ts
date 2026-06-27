/**
 * init-database helper — extrai JPEGs embutidos de um PDF de CNH-e.
 *
 * As CNH-e do SENATRAN costumam ser PDF com a carteira como imagem (sem texto),
 * então `importar-clientes-cnh` não obtém o CPF. Este helper varre os bytes do PDF
 * procurando marcadores JPEG (FFD8 … FFD9) e grava cada imagem em disco, para o
 * agente LER a imagem e extrair os dados (nome, CPF, RG, registro, validade, filiação).
 *
 * Uso:
 *   npx tsx .cursor/tools/init-database/extrair-jpg-cnh.ts <pdf> [prefixoSaida]
 *
 * Ex.:
 *   npx tsx .cursor/tools/init-database/extrair-jpg-cnh.ts ".../CNH-e.pdf" relatorios/_tmp/_cnh
 *   -> relatorios/_tmp/_cnh_0.jpg, _1.jpg, ...  (o maior costuma ser a frente da CNH)
 *
 * Não tem dependências (apenas fs/path) — pode correr isolado, sem o resto do projeto.
 */
import fs from "node:fs";
import path from "node:path";

const src = process.argv[2];
if (!src) {
  console.error("uso: extrair-jpg-cnh.ts <pdf> [prefixoSaida]");
  process.exit(1);
}
if (!fs.existsSync(src)) {
  console.error(`ficheiro não encontrado: ${src}`);
  process.exit(1);
}

const prefix = process.argv[3] ?? path.join("relatorios", "_tmp", "_cnh");
fs.mkdirSync(path.dirname(prefix), { recursive: true });

const buf = fs.readFileSync(src);
const MIN_BYTES = 5000; // ignora thumbnails/ícones minúsculos

let count = 0;
let i = 0;
while (i < buf.length - 1) {
  if (buf[i] === 0xff && buf[i + 1] === 0xd8) {
    let j = i + 2;
    while (j < buf.length - 1 && !(buf[j] === 0xff && buf[j + 1] === 0xd9)) j++;
    if (j < buf.length - 1) {
      const end = j + 2;
      const slice = buf.subarray(i, end);
      if (slice.length >= MIN_BYTES) {
        const out = `${prefix}_${count}.jpg`;
        fs.writeFileSync(out, slice);
        console.log(`escrito ${out} (${slice.length} bytes)`);
        count++;
      }
      i = end;
      continue;
    }
  }
  i++;
}

console.log(`Total JPEGs extraídos: ${count}`);
if (count === 0) {
  console.log(
    "Nenhum JPEG embutido (pode ser PNG/JBIG2). Tente ler o PDF diretamente ou converter a página.",
  );
}
