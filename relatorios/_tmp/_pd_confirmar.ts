import fs from "node:fs";

type Despesa = {
  autoInfracao: string;
  veiculoId: string;
  categoria?: string;
  condutorId?: string | null;
  condutorConfirmado?: boolean;
  condutorContrato?: string | null;
  dataAutuacao?: string;
  valorMulta?: number;
};

const db = JSON.parse(fs.readFileSync("database/cliente-despesas.json", "utf8")) as {
  clienteDespesas: Despesa[];
};
const clientes = JSON.parse(fs.readFileSync("database/clientes.json", "utf8")) as {
  clientes: { id: string; nome?: string }[];
};
const nome = (id?: string | null) =>
  (id && clientes.clientes.find((c) => c.id === id)?.nome) || id || "?";

const pend = db.clienteDespesas
  .filter(
    (d) =>
      (d.categoria ?? "") === "Pedágio" &&
      d.condutorConfirmado === false &&
      d.condutorId &&
      d.autoInfracao.startsWith("PED-"),
  )
  .sort((a, b) => `${a.veiculoId}${a.dataAutuacao}`.localeCompare(`${b.veiculoId}${b.dataAutuacao}`));

console.log(`PED-* com condutor inferido não confirmado: ${pend.length}\n`);
let placa = "";
for (const d of pend) {
  if (d.veiculoId !== placa) {
    placa = d.veiculoId;
    console.log(`\n== ${placa} ==`);
  }
  console.log(
    `  ${d.dataAutuacao} | R$ ${(d.valorMulta ?? 0).toFixed(2)} | ${d.autoInfracao} | ${nome(d.condutorId)}`,
  );
}
