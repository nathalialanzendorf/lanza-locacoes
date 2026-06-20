# -*- coding: utf-8 -*-
"""
Grava UMA despesa em database/despesas.json.

Uso:
    python gravar_despesa.py <categoria> <valor> <data DD/MM/AAAA> <placa> [descricao]

- Faz match da placa com veiculos.json (veiculoId = uuid do veículo; null se não cadastrada).
- competencia derivada de <data> (MM/AAAA).
"""
import json
import re
import sys
import uuid
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
DBD = ROOT / "database" / "despesas.json"
DBV = ROOT / "database" / "veiculos.json"


def norm(p):
    return re.sub(r"[^A-Za-z0-9]", "", (p or "")).upper()


def main():
    categoria = sys.argv[1]
    valor = (
        float(str(sys.argv[2]).replace(".", "").replace(",", "."))
        if ("," in sys.argv[2])
        else float(sys.argv[2])
    )
    data = sys.argv[3]
    placa = sys.argv[4]
    descricao = sys.argv[5] if len(sys.argv) > 5 else categoria

    comp = ""
    m = re.search(r"(\d{2})/(\d{4})$", data)
    if m:
        comp = f"{m.group(1)}/{m.group(2)}"
    else:
        m = re.match(r"\d{2}/(\d{2})/(\d{4})", data)
        if m:
            comp = f"{m.group(1)}/{m.group(2)}"

    desp = json.loads(DBD.read_text(encoding="utf-8"))
    veic = json.loads(DBV.read_text(encoding="utf-8"))
    v = next((x for x in veic["veiculos"] if norm(x["placa"]) == norm(placa)), None)

    reg = {
        "id": str(uuid.uuid4()),
        "veiculoId": v["id"] if v else None,
        "placa": v["placa"] if v else placa,
        "categoria": categoria,
        "descricao": descricao,
        "data": data,
        "valor": round(valor, 2),
        "competencia": comp,
        "origem": "manual",
    }
    desp["despesas"].append(reg)
    desp["atualizadoEm"] = date.today().isoformat()
    DBD.write_text(json.dumps(desp, ensure_ascii=False, indent=2), encoding="utf-8")
    aviso = "" if v else "  (placa nao cadastrada: veiculoId=null)"
    print(f"Despesa gravada: {categoria} R$ {reg['valor']:.2f} em {data} -> {reg['placa']}{aviso}")


if __name__ == "__main__":
    main()
