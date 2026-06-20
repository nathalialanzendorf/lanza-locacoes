# -*- coding: utf-8 -*-
"""
Consulta a tabela FIPE (API pública parallelum) — usado por cadastrar-veiculo.

Subcomandos:
    python fipe.py marca "peugeot"
    python fipe.py modelos <marcaCode> [filtro...]
    python fipe.py anos <marcaCode> <modeloCode> [filtro]
    python fipe.py valor <marcaCode> <modeloCode> <anoCode>
        -> imprime JSON {fipeCodigo, fipeModelo, price, modelYear, fuel, referenceMonth, url}
"""
import json
import re
import sys
import urllib.request

API = "https://fipe.parallelum.com.br/api/v2/cars"
UA = {"User-Agent": "Mozilla/5.0"}

_MES = {
    "janeiro": 1,
    "fevereiro": 2,
    "março": 3,
    "marco": 3,
    "abril": 4,
    "maio": 5,
    "junho": 6,
    "julho": 7,
    "agosto": 8,
    "setembro": 9,
    "outubro": 10,
    "novembro": 11,
    "dezembro": 12,
}


def get(path):
    req = urllib.request.Request(API + path, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def slug_marca(nome):
    n = nome.strip().lower()
    if n in ("vw", "volkswagen", "vw-volkswagen"):
        return "vw-volkswagen"
    return re.sub(r"[^a-z0-9]+", "-", n).strip("-")


def ref_para_mesano(ref):
    m = re.match(r"([a-zçãé]+)\s+de\s+(\d{4})", (ref or "").lower())
    if m:
        return f"{_MES.get(m.group(1), 0)}-{m.group(2)}"
    return ""


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    cmd = sys.argv[1]

    if cmd == "marca":
        alvo = sys.argv[2].lower()
        for b in get("/brands"):
            if alvo in b["name"].lower():
                print(b["code"], "|", b["name"])

    elif cmd == "modelos":
        mc = sys.argv[2]
        filtro = [w.lower() for w in sys.argv[3:]]
        for m in get(f"/brands/{mc}/models"):
            n = m["name"].lower()
            if all(w in n for w in filtro):
                print(m["code"], "|", m["name"])

    elif cmd == "anos":
        mc, mod = sys.argv[2], sys.argv[3]
        filtro = [w.lower() for w in sys.argv[4:]]
        for y in get(f"/brands/{mc}/models/{mod}/years"):
            n = y["name"].lower()
            if all(w in n for w in filtro):
                print(y["code"], "|", y["name"])

    elif cmd == "valor":
        mc, mod, ano = sys.argv[2], sys.argv[3], sys.argv[4]
        d = get(f"/brands/{mc}/models/{mod}/years/{ano}")
        marca_slug = slug_marca(d.get("brand", ""))
        mesano = ref_para_mesano(d.get("referenceMonth", ""))
        url = (
            f"https://veiculos.fipe.org.br?carro/{marca_slug}/{mesano}/"
            f"{d.get('codeFipe')}/{d.get('modelYear')}"
        )
        out = {
            "fipeCodigo": d.get("codeFipe"),
            "fipeModelo": d.get("model"),
            "price": d.get("price"),
            "modelYear": d.get("modelYear"),
            "fuel": d.get("fuel"),
            "referenceMonth": d.get("referenceMonth"),
            "url": url,
        }
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
