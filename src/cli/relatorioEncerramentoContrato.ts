import fs from "node:fs";
import path from "node:path";

import {
  calcularEncerramentoContrato,
  formatarEncerramentoTexto,
  type EncerramentoInput,
} from "../lib/encerrarContrato.js";
import { salvarRelatorioEncerramento } from "../lib/relatorioEncerramentoArquivo.js";

function parseArgs(argv: string[]): {
  jsonPath: string | null;
  pasta: string | null;
  encerramento: string | null;
  outJson: string | null;
  outTxt: string | null;
  incluirTodasMultas: boolean;
  noSalvar: boolean;
} {
  let jsonPath: string | null = null;
  let pasta: string | null = null;
  let encerramento: string | null = null;
  let outJson: string | null = null;
  let outTxt: string | null = null;
  let incluirTodasMultas = false;
  let noSalvar = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--encerramento" && argv[i + 1]) {
      encerramento = argv[++i]!;
    } else if (a === "--out-json" && argv[i + 1]) {
      outJson = argv[++i]!;
    } else if ((a === "--out" || a === "--out-txt") && argv[i + 1]) {
      outTxt = argv[++i]!;
    } else if (a === "--incluir-todas-infracoes-placa" || a === "--incluir-todas-multas-placa") {
      incluirTodasMultas = true;
    } else if (a === "--no-salvar") {
      noSalvar = true;
    } else if (!a.startsWith("-") && !jsonPath && !pasta) {
      if (a.endsWith(".json")) jsonPath = path.resolve(a);
      else pasta = path.resolve(a);
    }
  }
  return { jsonPath, pasta, encerramento, outJson, outTxt, incluirTodasMultas, noSalvar };
}

export function main(argv: string[]): void {
  const { jsonPath, pasta, encerramento, outJson, outTxt, incluirTodasMultas, noSalvar } =
    parseArgs(argv);

  let input: EncerramentoInput;
  if (jsonPath) {
    input = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as EncerramentoInput;
  } else if (pasta && encerramento) {
    input = {
      pastaContrato: pasta,
      dataEncerramento: encerramento,
      incluirTodasMultasPlaca: incluirTodasMultas,
    };
  } else {
    console.error(`Uso:
  relatorio-encerramento-contrato <pasta-contrato> --encerramento DD/MM/AAAA [opções]
  relatorio-encerramento-contrato <entrada.json> [opções]

Grava automaticamente em relatorios/quebra-contrato/:
  quebra-contrato-{placa}-{cliente}-{DD-MM-AAAA}.txt   (documento p/ WhatsApp)
  quebra-contrato-{placa}-{cliente}-{DD-MM-AAAA}.json  (dados p/ canvas)

Opções:
  --incluir-todas-infracoes-placa
  --out caminho.txt        Sobrescreve o .txt (documento para o cliente)
  --out-json caminho.json  Sobrescreve o caminho do JSON (default: ao lado do .txt)
  --no-salvar              Só imprime no terminal (não grava ficheiros)

Apenas calcula o acerto. Para efetivar: cadastro-contrato encerrar ...
`);
    process.exit(1);
  }

  const result = calcularEncerramentoContrato(input);
  const texto = formatarEncerramentoTexto(result);
  console.log(texto);

  if (!noSalvar) {
    const saved = salvarRelatorioEncerramento(result, texto, {
      outJson: outJson ?? undefined,
      outTxt: outTxt ?? undefined,
    });
    console.log(`\nRelatório gravado:`);
    console.log(`  TXT -> ${saved.txt}`);
    if (saved.json) console.log(`  JSON -> ${saved.json}`);
  }
}
