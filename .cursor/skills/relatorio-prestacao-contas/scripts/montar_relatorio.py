# -*- coding: utf-8 -*-
"""
Monta o Relatório de Prestação de Contas mensal — um arquivo por parceiro.

Uso:
    python montar_relatorio.py entrada.json
"""
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
DB = ROOT / "database"


def _lanza_paths_cfg():
    cfg = ROOT / "config" / "lanza_paths.json"
    if cfg.is_file():
        return json.loads(cfg.read_text(encoding="utf-8"))
    return {}


def _prestacao_base_dir():
    p = _lanza_paths_cfg()
    fin = p.get("financeiro")
    if fin:
        sub = p.get("prestacaoContasSubpasta") or "prestação de contas"
        return Path(fin) / sub
    return ROOT / "prestação de contas"


BASE_DIR = _prestacao_base_dir()

SEM_SEGURO = {"luiz paulo", "jhonny", "baiano"}


def load(n):
    return json.loads((DB / n).read_text(encoding="utf-8"))


def brl(v):
    s = f"{float(v):,.2f}"
    return s.replace(",", "X").replace(".", ",").replace("X", ".")


def norm(p):
    return re.sub(r"[^A-Za-z0-9]", "", (p or "")).upper()


def modelo_curto(mm):
    return (mm or "").split("/")[-1].split()[0] if mm else ""


def ano_curto(am):
    return (am or "").split("/")[-1] if am else ""


def main(path):
    inp = json.loads(Path(path).read_text(encoding="utf-8"))
    comp = inp["competencia"]
    mm_comp, aaaa_comp = comp.split("/")
    pasta_comp = f"{mm_comp}.{aaaa_comp}"

    comps_desp = inp.get("competenciasDespesas") or [comp]
    periodo = inp.get("periodo") or {}
    rotulo = inp.get("rotulo")

    rast_valor = float(inp.get("rastreadorValor", 50.0))
    rast_dia = int(inp.get("rastreadorDia", 10))

    despesas = load("despesas.json")["despesas"]
    veiculos = {norm(v["placa"]): v for v in load("veiculos.json")["veiculos"]}
    parceiros = {p["id"]: p for p in load("parceiros.json")["parceiros"]}
    dono_id = {l["veiculoId"]: l["parceiroId"] for l in load("parceiro-veiculo.json")["vinculos"]}

    def dono_nome(vid):
        pid = dono_id.get(vid)
        return parceiros.get(pid, {}).get("nome", "?") if pid else "?"

    por_parceiro = {}
    avisos_globais = []
    for item in inp["veiculos"]:
        v = veiculos.get(norm(item["placa"]))
        if not v:
            avisos_globais.append(f"Veículo {item['placa']} não cadastrado — pulado.")
            continue
        parceiro = dono_nome(v["id"])
        por_parceiro.setdefault(parceiro, []).append((item, v))

    out_dir = BASE_DIR / pasta_comp
    out_dir.mkdir(parents=True, exist_ok=True)
    arquivos_gerados = []

    for parceiro, itens in por_parceiro.items():
        linhas = []
        tg = tga = tt = 0.0
        avisos_parc = []
        tem_seguro = parceiro.lower().strip() not in SEM_SEGURO

        for item, v in itens:
            gastos = [
                dict(d)
                for d in despesas
                if d.get("competencia") in comps_desp
                and norm(d.get("placa", "")) == norm(v["placa"])
            ]

            if tem_seguro and not any(
                (d.get("categoria") or "").lower() == "seguro" for d in gastos
            ):
                avisos_parc.append(f"  ⚠️ {v['placa']}: SEGURO de {comp} não importado.")

            if not any((d.get("categoria") or "").lower() == "rastreador" for d in gastos):
                gastos.append(
                    {
                        "data": f"{rast_dia:02d}/{mm_comp}/{aaaa_comp}",
                        "categoria": "Rastreador",
                        "descricao": "Rastreador",
                        "valor": rast_valor,
                    }
                )

            gastos.sort(key=lambda d: d.get("data", ""))
            soma = sum(float(d["valor"]) for d in gastos)
            ganho = item.get("ganho", {})
            gval = float(ganho.get("valor", 0) or 0)
            devido = float(item.get("devidoMesAnterior", 0) or 0)
            desc = item.get("descontoManutencao", {}) or {}
            dval = float(desc.get("valor", 0) or 0)
            total_descontos = soma + devido + dval
            total = gval - total_descontos

            modelo = modelo_curto(v["marcaModelo"])
            ano = ano_curto(v["anoModelo"])
            L = [f"*{v['placa']} - {modelo} {ano} ({parceiro})*", ""]
            for d in gastos:
                L.append(f"\t{d['data']}\t{d['descricao']}\tR$ {brl(d['valor'])}")
            L += ["", f"Total: R$ {brl(soma)}", ""]
            L.append(f"Desconto mês anterior: R$ {brl(devido)}")
            dm = f"Desconto manutenção: R$ {brl(dval)}"
            if desc.get("descricao"):
                dm += f" ({desc['descricao']})"
            L.append(dm)
            L += [
                "",
                f"Total Ganho: R$ {brl(gval)}"
                + (f" ({ganho.get('descricao')})" if ganho.get("descricao") else ""),
            ]
            L.append(f"Total Descontos: R$ {brl(total_descontos)}")
            L += ["", f"*TOTAL: R$ {brl(total)}*"]
            linhas.append("\n".join(L))
            tg += total_descontos
            tga += gval
            tt += total

        linhas.append(
            f"=== CONSOLIDADO {parceiro.upper()} — {comp} ===\n"
            f"TOTAL Descontos:\tR$ {brl(tg)}\n"
            f"TOTAL Ganhos:\t\tR$ {brl(tga)}\n"
            f"TOTAL líquido:\t\tR$ {brl(tt)}"
        )

        cab = []
        comp_txt = (
            f" (Competência {periodo['inicio']} a {periodo['fim']})"
            if periodo.get("inicio") and periodo.get("fim")
            else ""
        )
        if rotulo:
            cab.append(rotulo + comp_txt)
        elif comp_txt:
            cab.append("Relatório" + comp_txt)
        corpo = "\n\n\n".join(linhas)
        texto = (("\n".join(cab) + "\n\n\n") if cab else "") + corpo + "\n"
        saida = out_dir / f"{parceiro}.txt"
        saida.write_text(texto, encoding="utf-8")
        arquivos_gerados.append((parceiro, str(saida)))
        print(texto)
        if avisos_parc:
            for a in avisos_parc:
                print(a)

    print(f"\n[arquivos gerados em {out_dir}]")
    for p, s in arquivos_gerados:
        print(f"  {p}: {s}")
    if avisos_globais:
        for a in avisos_globais:
            print(a)


if __name__ == "__main__":
    main(sys.argv[1])
