# -*- coding: utf-8 -*-
"""
Grava despesas de seguro (extraídas dos comprovantes PDF) em database/despesas.json.

Os PDFs são lidos pela skill / agente a partir de seguroComprovantesDir
(config/lanza_paths.json). veiculoId referencia veiculos.json pelo uuid.

Uso:
    python gravar_despesas.py boletos.json
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


def main(path):
    boletos = json.loads(Path(path).read_text(encoding="utf-8"))
    desp = json.loads(DBD.read_text(encoding="utf-8"))
    veic = json.loads(DBV.read_text(encoding="utf-8"))

    by_placa = {norm(v["placa"]): v for v in veic["veiculos"]}
    existentes = desp["despesas"]
    por_origem = {d.get("origem"): d for d in existentes}

    novos, atualizados, sem_veiculo = 0, 0, []
    for b in boletos:
        v = by_placa.get(norm(b["placa"]))
        if not v:
            sem_veiculo.append(b["placa"])
        registro = {
            "veiculoId": v["id"] if v else None,
            "placa": v["placa"] if v else b["placa"],
            "categoria": "Seguro",
            "descricao": "Seguro",
            "data": b.get("data"),
            "valor": round(float(b["valor"]), 2),
            "competencia": b.get("competencia"),
            "origem": b.get("origem"),
        }
        ex = por_origem.get(b.get("origem"))
        if ex:
            registro["id"] = ex["id"]
            existentes[:] = [registro if d is ex else d for d in existentes]
            atualizados += 1
        else:
            registro["id"] = str(uuid.uuid4())
            existentes.append(registro)
            por_origem[b.get("origem")] = registro
            novos += 1

    desp["atualizadoEm"] = date.today().isoformat()
    DBD.write_text(json.dumps(desp, ensure_ascii=False, indent=2), encoding="utf-8")

    total = sum(d["valor"] for d in existentes if d["categoria"] == "Seguro")
    print(f"Seguro: {novos} novos, {atualizados} atualizados. Total seguros na base: R$ {total:.2f}")
    if sem_veiculo:
        print("Placas sem veiculo cadastrado:", ", ".join(sem_veiculo))


if __name__ == "__main__":
    main(sys.argv[1])
