/**
 * CLI rastreame.com.br — motorista e login (usa lib em src/lib/rastreame/).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

import { loginRastreame } from "../lib/rastreame/auth.js";
import { findMotorista, postMotorista } from "../lib/rastreame/motorista.js";

/** Grava uma variável de ambiente persistente do utilizador (Windows). */
function persistUserEnv(name: string, value: string): boolean {
  if (process.platform !== "win32") {
    console.warn(
      `[rastreame] --save só persiste em Windows. Defina manualmente ${name} no seu shell.`,
    );
    return false;
  }
  const ps = `[Environment]::SetEnvironmentVariable('${name}', $env:LANZA_TOKEN_TMP, 'User')`;
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", ps],
    { env: { ...process.env, LANZA_TOKEN_TMP: value }, stdio: "inherit" },
  );
  return r.status === 0;
}

async function loginCmd(argv: string[]): Promise<void> {
  const save = argv.includes("--save");
  const token = await loginRastreame();
  if (!token) {
    console.error(
      "ERRO: login falhou. Defina RASTREAME_LOGIN e RASTREAME_SENHA nas variáveis de ambiente do utilizador e tente novamente.",
    );
    process.exit(2);
  }
  console.log("OK: login efetuado. Token (header x-r2f-auth):\n");
  console.log(token);
  if (save) {
    if (persistUserEnv("RASTREAME_AUTH", token)) {
      console.log(
        "\nOK: RASTREAME_AUTH gravado nas variáveis de ambiente do utilizador.\n    Feche e reabra os terminais (ou o Cursor) para aplicar.",
      );
    } else {
      console.error("\nERRO: não foi possível gravar RASTREAME_AUTH.");
      process.exit(2);
    }
  } else {
    console.log(
      "\nDica: use `rastreame login --save` para gravar em RASTREAME_AUTH (utilizador),",
    );
    console.log(
      "      ou: [Environment]::SetEnvironmentVariable('RASTREAME_AUTH', '<token>', 'User')",
    );
  }
}

export async function main(argv: string[]): Promise<void> {
  if (argv.length < 1) {
    console.error(`Uso:
  rastreame login [--save]
  rastreame check <cnh> ["nome"]
  rastreame add <cliente.json>`);
    process.exit(2);
  }
  const cmd = argv[0]!;
  if (cmd === "login") {
    await loginCmd(argv.slice(1));
  } else if (cmd === "check") {
    const cnh = argv[1] ?? "";
    const nome = argv[2] ?? "";
    const m = await findMotorista(cnh, nome);
    console.log(
      m ? `JA CADASTRADO: ${m.nome} (id ${m.id})` : "NAO CADASTRADO",
    );
  } else if (cmd === "add") {
    await postMotorista(path.resolve(argv[1]!));
  } else {
    console.error("Comando desconhecido:", cmd);
    process.exit(2);
  }
}
