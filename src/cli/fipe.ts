/**
 * CLI de consulta FIPE — wrapper fino da tool `src/lib/fipe`.
 */
import {
  consultarValor,
  listarAnos,
  listarMarcas,
  listarModelos,
  montarUrlFipe,
} from "../lib/fipe/index.js";

export async function main(argv: string[]): Promise<void> {
  if (argv.length < 1) {
    console.error(`Uso:
  fipe marca <texto>
  fipe modelos <marcaCode> [filtro...]
  fipe anos <marcaCode> <modeloCode> [filtro]
  fipe valor <marcaCode> <modeloCode> <anoCode>`);
    process.exit(2);
  }
  const cmd = argv[0]!;

  if (cmd === "marca") {
    const alvo = argv[1];
    if (!alvo) {
      console.error("Uso: fipe marca <texto>");
      process.exit(2);
    }
    const alvoLower = alvo.toLowerCase();
    const brands = await listarMarcas();
    for (const b of brands) {
      if (alvoLower && !b.name.toLowerCase().includes(alvoLower)) continue;
      console.log(b.code, "|", b.name);
    }
  } else if (cmd === "modelos") {
    const mc = argv[1]!;
    const filtro = argv.slice(2).map((w) => w.toLowerCase());
    const models = await listarModelos(mc);
    for (const m of models) {
      const n = m.name.toLowerCase();
      if (filtro.length && !filtro.every((w) => n.includes(w))) continue;
      console.log(m.code, "|", m.name);
    }
  } else if (cmd === "anos") {
    const mc = argv[1]!;
    const mod = argv[2]!;
    const filtro = argv.slice(3).map((w) => w.toLowerCase());
    const years = await listarAnos(mc, mod);
    for (const y of years) {
      const n = y.name.toLowerCase();
      if (filtro.length && !filtro.every((w) => n.includes(w))) continue;
      console.log(y.code, "|", y.name);
    }
  } else if (cmd === "valor") {
    const mc = argv[1]!;
    const mod = argv[2]!;
    const ano = argv[3]!;
    const d = await consultarValor(mc, mod, ano);
    const out = {
      fipeCodigo: d.codeFipe,
      fipeModelo: d.model,
      price: d.price,
      modelYear: d.modelYear,
      fuel: d.fuel,
      referenceMonth: d.referenceMonth,
      url: montarUrlFipe(d),
    };
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.error("Comando desconhecido:", cmd);
    process.exit(2);
  }
}
