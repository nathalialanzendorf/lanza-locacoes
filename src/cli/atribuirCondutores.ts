import { reconciliarCondutores } from "../lib/atribuirCondutores.js";

/**
 * Concilia o condutor das infrações/pedágios pendentes pela vigência do contrato.
 * Uso: atribuir-condutores [--placa PLACA] [--dry-run] [--prazo-dias N]
 */
export function main(argv: string[]): void {
  const dryRun = argv.includes("--dry-run");
  const incluirPedagios = argv.includes("--incluir-pedagios");
  const placaIdx = argv.indexOf("--placa");
  const placa = placaIdx >= 0 ? argv[placaIdx + 1] : undefined;
  const prazoIdx = argv.indexOf("--prazo-dias");
  const prazoDias = prazoIdx >= 0 ? Number(argv[prazoIdx + 1]) : undefined;

  const r = reconciliarCondutores({ dryRun, placa, prazoDias, incluirPedagios });

  console.log(
    `Conciliação de condutores${dryRun ? " (DRY-RUN)" : ""}: ${r.total} pendentes` +
      ` | vinculados: ${r.vinculados} | não identificados: ${r.naoIdentificados}` +
      ` | cliente faltando: ${r.clienteFaltando} | sem data: ${r.semData}`,
  );

  const ordem: Record<string, number> = {
    vinculado: 0,
    "nao-identificado": 1,
    "cliente-faltando": 2,
    "sem-data": 3,
  };
  for (const i of [...r.itens].sort((a, b) => ordem[a.acao]! - ordem[b.acao]! || a.veiculoId.localeCompare(b.veiculoId))) {
    const ref = i.cliente ? ` ← ${i.cliente}` : "";
    console.log(
      `  • [${i.acao}] ${i.veiculoId} | ${i.autoInfracao} | ${i.dataAutuacao} | R$ ${i.valorMulta.toFixed(2)}${ref}`,
    );
  }
  if (dryRun) console.log("\n(DRY-RUN — nada gravado. Rode sem --dry-run para aplicar.)");
}
