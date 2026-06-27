import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { REPO_ROOT } from "../lib/repoRoot.js";
import { syncFipeNovoVeiculo } from "./atualizarFipeVeiculos.js";

const DBV = path.join(REPO_ROOT, "database", "veiculos.json");
const DBP = path.join(REPO_ROOT, "database", "parceiros.json");
const DBL = path.join(REPO_ROOT, "database", "parceiro-veiculo.json");

type Veiculo = Record<string, unknown> & { id?: string; placa?: string };
type Parceiro = { id: string; nome: string };
type Vinculo = { id: string; veiculoId: string; parceiroId: string };

export async function main(argv: string[]): Promise<void> {
  const novoPath = path.resolve(argv[0]!);
  const dono = argv[1]!.trim();
  const novo = JSON.parse(fs.readFileSync(novoPath, "utf8")) as Veiculo;

  const veic = JSON.parse(fs.readFileSync(DBV, "utf8")) as {
    veiculos: Veiculo[];
    atualizadoEm?: string;
  };
  const parc = JSON.parse(fs.readFileSync(DBP, "utf8")) as {
    parceiros: Parceiro[];
    atualizadoEm?: string;
  };
  const link = JSON.parse(fs.readFileSync(DBL, "utf8")) as {
    vinculos: Vinculo[];
    atualizadoEm?: string;
  };

  const placaN = String(novo.placa || "").toUpperCase();
  const ex = veic.veiculos.find(
    (v) => String(v.placa || "").toUpperCase() === placaN,
  );
  let acao: "atualizado" | "cadastrado";
  if (ex) {
    novo.id = ex.id;
    veic.veiculos = veic.veiculos.map((v) => (v === ex ? novo : v));
    acao = "atualizado";
  } else {
    novo.id = crypto.randomUUID();
    veic.veiculos.push(novo);
    acao = "cadastrado";
  }

  let p = parc.parceiros.find((x) => x.nome.toLowerCase() === dono.toLowerCase());
  if (!p) {
    p = { id: crypto.randomUUID(), nome: dono };
    parc.parceiros.push(p);
  }

  const vid = String(novo.id);
  const pid = p.id;
  link.vinculos = link.vinculos.filter((l) => l.veiculoId !== vid);
  link.vinculos.push({
    id: crypto.randomUUID(),
    veiculoId: vid,
    parceiroId: pid,
  });

  const today = new Date().toISOString().slice(0, 10);
  novo.atualizadoEm = new Date().toISOString();
  veic.atualizadoEm = today;
  parc.atualizadoEm = today;
  link.atualizadoEm = today;
  fs.writeFileSync(DBV, JSON.stringify(veic, null, 2), "utf8");
  fs.writeFileSync(DBP, JSON.stringify(parc, null, 2), "utf8");
  fs.writeFileSync(DBL, JSON.stringify(link, null, 2), "utf8");
  console.log(
    `Veiculo ${acao}: ${novo.placa} (id ${novo.id}) -> proprietario ${p.nome}`,
  );

  if (!process.argv.includes("--no-sync-rastreame")) {
    try {
      const { findVeiculoById } = await import("../lib/veiculosDb.js");
      const { replicarVeiculoNoRastreame } = await import("../lib/rastreame/rastreaveisSync.js");
      const reg = findVeiculoById(String(novo.id));
      if (reg) {
        await replicarVeiculoNoRastreame(reg);
        console.log(`     → replicado no Rastreame (key=${reg.rastreameRastreavelKey ?? "novo"})`);
      }
    } catch (e) {
      console.error(
        `     [aviso] falha sync Rastreame: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  if (acao === "cadastrado") {
    await syncFipeNovoVeiculo(String(novo.placa || ""));
  }
}
