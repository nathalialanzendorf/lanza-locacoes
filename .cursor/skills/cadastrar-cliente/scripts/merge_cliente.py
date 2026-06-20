# -*- coding: utf-8 -*-
"""Merge um objeto cliente (sem id) em database/clientes.json por CPF."""
import json
import sys
import uuid
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
DB = ROOT / "database" / "clientes.json"


def main():
    path = Path(sys.argv[1])
    novo = json.loads(path.read_text(encoding="utf-8"))
    db = json.loads(DB.read_text(encoding="utf-8"))
    existente = next((c for c in db["clientes"] if c.get("cpf") == novo.get("cpf")), None)
    if existente:
        novo["id"] = existente["id"]
        db["clientes"] = [novo if c is existente else c for c in db["clientes"]]
        acao = "atualizado"
    else:
        novo["id"] = str(uuid.uuid4())
        db["clientes"].append(novo)
        acao = "cadastrado"
    db["atualizadoEm"] = date.today().isoformat()
    DB.write_text(json.dumps(db, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Cliente {acao}: {novo['nome']} (id {novo['id']})")


if __name__ == "__main__":
    main()
