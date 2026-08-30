/**
 * Aplica packages/db/sql/028_documento_gerado_versao.sql
 * Uso: PGPASSWORD=<token IAM> npx tsx scripts/apply-migration-028.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { closePgPool, getDefaultPostgresPool } from "@lanza/db";

function loadEnvLocal(): void {
  const envLocal = resolve(process.cwd(), ".env.local");
  if (!existsSync(envLocal)) return;
  for (const line of readFileSync(envLocal, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m || process.env[m[1]!]) continue;
    let v = m[2]!.trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    process.env[m[1]!] = v;
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  process.env.LANZA_DB_BACKEND = "postgres";

  if (!process.env.PGPASSWORD?.trim()) {
    throw new Error("Defina PGPASSWORD com o token IAM RDS.");
  }
  delete process.env.AWS_ROLE_ARN;
  delete process.env.VERCEL_OIDC_TOKEN;

  if (!process.env.PGHOST?.trim()) {
    process.env.PGHOST =
      "aws-pg-lanza-locacoes.cluster-c856s8wi6jzs.us-east-1.rds.amazonaws.com";
  }
  process.env.PGPORT ??= "5432";
  process.env.PGUSER ??= "postgres";
  process.env.PGDATABASE ??= "postgres";
  process.env.PGSSLMODE ??= "require";

  const pool = getDefaultPostgresPool();
  const sqlPath = resolve(process.cwd(), "packages/db/sql/028_documento_gerado_versao.sql");
  const sql = readFileSync(sqlPath, "utf8");

  console.log("Aplicando 028_documento_gerado_versao.sql …");
  await pool.query(sql, undefined, "migration-028");

  const check = await pool.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'lanza'
       AND table_name = 'contratos'
       AND column_name = 'documento_gerado_versao'`,
    undefined,
    "check-028",
  );

  const count = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
     FROM lanza.contratos
     WHERE documento_gerado_em IS NOT NULL
       AND documento_gerado_versao IS NOT NULL`,
    undefined,
    "check-028-count",
  );

  if (check.rows.length) {
    console.log("OK: coluna documento_gerado_versao existe.");
    console.log(`Contratos com versao preenchida: ${count.rows[0]?.n ?? "0"}`);
  } else {
    console.log("ERRO: coluna documento_gerado_versao ausente.");
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => closePgPool());
