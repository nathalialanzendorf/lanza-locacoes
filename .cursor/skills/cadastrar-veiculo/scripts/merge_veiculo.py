# -*- coding: utf-8 -*-
"""Merge veículo (sem id) em veiculos.json + parceiros + parceiro-veiculo."""
import json
import shutil
import subprocess
import sys
import uuid
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
DBV = ROOT / "database" / "veiculos.json"
DBP = ROOT / "database" / "parceiros.json"
DBL = ROOT / "database" / "parceiro-veiculo.json"
FIPE_SYNC = (
    ROOT
    / ".cursor"
    / "skills"
    / "cadastrar-veiculo"
    / "scripts"
    / "atualizar_fipe_veiculos.mjs"
)


def _sync_fipe_novo_veiculo(placa: str) -> None:
    """Atualiza fipe/fipeCodigo/fipeModelo/fipeValor/fipeReferencia na API FIPE."""
    if not placa or not FIPE_SYNC.is_file():
        if placa and not FIPE_SYNC.is_file():
            print(f"[aviso] Script FIPE ausente: {FIPE_SYNC}")
        return
    node = shutil.which("node")
    if not node:
        print(
            "[aviso] node nao encontrado no PATH; sincronize FIPE manualmente:\n"
            f'  node "{FIPE_SYNC}" --placa {placa}'
        )
        return
    try:
        r = subprocess.run(
            [node, str(FIPE_SYNC), "--placa", placa],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
        )
        out = (r.stdout or "").strip()
        err = (r.stderr or "").strip()
        if out:
            print(out)
        if r.returncode != 0:
            print(f"[aviso] FIPE sync exit {r.returncode}")
            if err:
                print(err)
        else:
            print("[fipe] campos FIPE atualizados na API")
    except subprocess.TimeoutExpired:
        print("[aviso] FIPE sync excedeu 180s; rode manualmente com --placa")
    except OSError as e:
        print(f"[aviso] FIPE sync: {e}")


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
        p = {"id": str(uuid.uuid4()), "nome": dono}
        parc["parceiros"].append(p)

    vid = novo["id"]
    pid = p["id"]
    link["vinculos"] = [l for l in link["vinculos"] if l["veiculoId"] != vid]
    link["vinculos"].append(
        {"id": str(uuid.uuid4()), "veiculoId": vid, "parceiroId": pid}
    )

    today = date.today().isoformat()
    for d, path in [(veic, DBV), (parc, DBP), (link, DBL)]:
        d["atualizadoEm"] = today
        path.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Veiculo {acao}: {novo['placa']} (id {novo['id']}) -> proprietario {p['nome']}")

    if acao == "cadastrado":
        _sync_fipe_novo_veiculo(novo.get("placa") or "")


if __name__ == "__main__":
    main()
