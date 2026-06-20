/**
 * Orquestrador multiagente: 3x Agent.prompt em sequência (Extrator → Montador → Revisor).
 * Uso: node orchestrator.mjs <path-cnh-relativo-ao-repo> <path-residencia-relativo-ao-repo>
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "@cursor/sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Raiz do repositório worklanza (dois níveis acima desta pasta). */
const REPO_ROOT = join(__dirname, "..", "..");
const PROMPTS_DIR = join(__dirname, "..", "prompts");

function loadPrompt(name) {
  return readFileSync(join(PROMPTS_DIR, name), "utf8");
}

async function main() {
  const apiKey = process.env.CURSOR_API_KEY;
  if (!apiKey) {
    console.error("Defina a variável de ambiente CURSOR_API_KEY.");
    process.exit(1);
  }

  const cnhPath = process.argv[2];
  const residPath = process.argv[3];
  if (!cnhPath || !residPath) {
    console.error(
      "Uso: node orchestrator.mjs <path-cnh> <path-residencia> (caminhos relativos à raiz do repo)",
    );
    process.exit(1);
  }

  const model = { id: "composer-2.5" };
  const local = { cwd: REPO_ROOT };

  const extrator = loadPrompt("01-extrator.md");
  const prompt1 = `${extrator}

Arquivos (relativos à raiz do repositório):
- CNH: ${cnhPath}
- Residência: ${residPath}

Workspace raiz: ${REPO_ROOT}
`;

  console.error("[1/3] Extrator…");
  const r1 = await Agent.prompt(prompt1, { apiKey, model, local });
  if (r1.status === "error") {
    console.error("Extrator falhou:", r1);
    process.exit(2);
  }
  console.log("=== SAÍDA EXTRATOR ===\n", r1.result, "\n");

  const montador = loadPrompt("02-montador.md");
  const prompt2 = `${montador}

JSON do extrator (use exatamente estes dados):
${r1.result}
`;

  console.error("[2/3] Montador…");
  const r2 = await Agent.prompt(prompt2, { apiKey, model, local });
  if (r2.status === "error") {
    console.error("Montador falhou:", r2);
    process.exit(2);
  }
  console.log("=== SAÍDA MONTADOR ===\n", r2.result, "\n");

  const revisor = loadPrompt("03-revisor.md");
  const prompt3 = `${revisor}

JSON do extrator:
${r1.result}

Saída do montador:
${r2.result}
`;

  console.error("[3/3] Revisor…");
  const r3 = await Agent.prompt(prompt3, { apiKey, model, local });
  if (r3.status === "error") {
    console.error("Revisor falhou:", r3);
    process.exit(2);
  }
  console.log("=== SAÍDA REVISOR ===\n", r3.result, "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
