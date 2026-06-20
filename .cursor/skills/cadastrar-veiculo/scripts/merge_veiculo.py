# -*- coding: utf-8 -*-
"""Merge veículo (sem id) em veiculos.json + parceiros + parceiro-veiculo."""
import json
import sys
import uuid
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
DBV = ROOT / "database" / "veiculos.json"
DBP = ROOT / "database" / "parceiros.json"
DBL = ROOT / "database" / "parceiro-veiculo.json"


def main():
    novo_path = Path(sys.argv[1])
    dono = sys.argv[2].strip()
    novo = json.loads(novo_path.read_text(encoding="utf-8"))

    veic = json.loads(DBV.read_text(encoding="utf-8"))
    parc = json.loads(DBP.read_text(encoding="utf-8"))
    link = json.loads(DBL.read_text(encoding="utf-8"))

    ex = next(
        (
            v
            for v in veic["veiculos"]
            if (v.get("placa") or "").upper() == (novo.get("placa") or "").upper()
        ),
        None,
    )
    if ex:
        novo["id"] = ex["id"]
        veic["veiculos"] = [novo if v is ex else v for v in veic["veiculos"]]
        acao = "atualizado"
    else:
        novo["id"] = str(uuid.uuid4())
        veic["veiculos"].append(novo)
        acao = "cadastrado"

    p = next((x for x in parc["parceiros"] if x["nome"].lower() == dono.lower()), None)
    if not p:
        p = {
            "id": str(uuid.uuid4()),
            "nome": dono,
            "tipo": "empresa" if "lanza" in dono.lower() else "parceiro",
        }
        parc["parceiros"].append(p)

    link["vinculos"] = [l for l in link["vinculos"] if l["veiculoId"] != novo["id"]]
    link["vinculos"].append(
        {"id": str(uuid.uuid4()), "veiculoId": novo["id"], "parceiroId": p["id"]}
    )

    today = date.today().isoformat()
    for d, path in [(veic, DBV), (parc, DBP), (link, DBL)]:
        d["atualizadoEm"] = today
        path.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Veiculo {acao}: {novo['placa']} (id {novo['id']}) -> proprietario {p['nome']}")


if __name__ == "__main__":
    main()
