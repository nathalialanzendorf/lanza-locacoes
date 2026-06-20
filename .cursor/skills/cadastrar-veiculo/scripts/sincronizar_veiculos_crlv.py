# -*- coding: utf-8 -*-
"""
Atualiza database/veiculos.json a partir de PDFs de CRLV nas pastas de documentos.

Procura em:
  - config/lanza_paths.json -> documentosRaiz (ex.: D:/Dropbox/Aluguel Carros)
  - na raiz do repo: veiculos/*.pdf (fallback)

Nome do arquivo: placa sem hífen (ex.: MLN0B87.pdf) ou com sufixo (1).

Uso (na raiz do repo):
  py -3 .cursor/skills/cadastrar-veiculo/scripts/sincronizar_veiculos_crlv.py
  py -3 .../sincronizar_veiculos_crlv.py --dry-run
  py -3 .../sincronizar_veiculos_crlv.py --placa MLN-0B87

Dependência: pip install pypdf
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
DBV = ROOT / "database" / "veiculos.json"
CFG = ROOT / "config" / "lanza_paths.json"
VEIC_DIR = ROOT / "veiculos"


def compact_placa(p: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (p or "").upper())


def format_placa_hyphen(p: str) -> str:
    c = compact_placa(p)
    if len(c) == 7:
        return f"{c[:3]}-{c[3:]}"
    return c


def load_documentos_raiz() -> Path | None:
    if not CFG.is_file():
        return None
    try:
        cfg = json.loads(CFG.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    p = cfg.get("documentosRaiz") or ""
    if not p:
        return None
    return Path(p)


def normalize_pdf_stem(stem: str) -> str:
    stem = re.sub(r"\s*\(\d+\)\s*$", "", stem.strip())
    return compact_placa(stem)


def collect_crlv_index(roots: list[Path]) -> dict[str, Path]:
    """placa compacta -> um PDF (se houver vários, prefere caminho mais curto)."""
    buckets: dict[str, list[Path]] = defaultdict(list)
    for root in roots:
        if not root.is_dir():
            continue
        try:
            for pdf in root.rglob("*.pdf"):
                if pdf.name.startswith("~$"):
                    continue
                key = normalize_pdf_stem(pdf.stem)
                if len(key) != 7:
                    continue
                buckets[key].append(pdf)
        except OSError:
            continue
    index: dict[str, Path] = {}
    for key, paths in buckets.items():
        best = min(paths, key=lambda p: (len(p.parts), str(p).lower()))
        index[key] = best
    return index


def extract_pdf_text(path: Path) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as e:
        raise SystemExit(
            "Instale pypdf: py -m pip install pypdf\n"
            "  (ou: python -m pip install pypdf)"
        ) from e
    reader = PdfReader(str(path))
    parts: list[str] = []
    for page in reader.pages:
        t = page.extract_text()
        if t:
            parts.append(t)
    return "\n".join(parts)


def _line_blocks(text: str) -> list[str]:
    return [ln.strip() for ln in text.replace("\r", "\n").split("\n")]


def _next_meaningful(lines: list[str], start: int) -> str | None:
    skip = {"", "-", ".", "..."}
    for j in range(start, min(start + 8, len(lines))):
        s = lines[j].strip()
        if s and s not in skip:
            return s
    return None


def _find_line_value(lines: list[str], *labels: str) -> str | None:
    """Valor na linha seguinte a um rótulo que contenha qualquer `labels`."""
    for i, ln in enumerate(lines):
        u = ln.upper()
        for lab in labels:
            if lab.upper() in u and len(u) < 80:
                v = _next_meaningful(lines, i + 1)
                if v:
                    return v
    return None


def parse_crlv(text: str) -> dict[str, str]:
    """Extrai campos comuns do texto do CRLV (varia conforme estado/PDF)."""
    out: dict[str, str] = {}
    lines = _line_blocks(text)
    raw = "\n".join(lines)

    # Chassi (17 caracteres, sem I/O/Q)
    m = re.search(
        r"CHASSI\s*[:\s]*([A-HJ-NPR-Z0-9]{17})", raw, re.I
    ) or re.search(r"\b([A-HJ-NPR-Z0-9]{17})\b", raw)
    if m:
        cand = m.group(1).upper()
        if len(cand) == 17:
            out["chassi"] = cand

    m = re.search(r"RENAVAM\s*[:\s]*(\d{10,11})\b", raw, re.I)
    if m:
        out["renavam"] = m.group(1)

    # Placa no documento
    m = re.search(
        r"PLACA\s*[:\s]*([A-Z]{3}[\dA-Z][A-Z0-9]{4}|[A-Z]{3}\d{4})\b", raw, re.I
    )
    if m:
        out["placa_doc"] = format_placa_hyphen(m.group(1))

    # Marca / modelo (linha após rótulo)
    mm = _find_line_value(
        lines,
        "MARCA / MODELO",
        "MARCA/MODELO",
        "MARCA E MODELO",
        "MARCAMODELO",
    )
    if mm:
        mm = re.sub(r"\s+", " ", mm).strip()
        if "/" in mm or re.search(r"[A-Z]{2,}", mm, re.I):
            out["marcaModelo"] = mm.upper() if mm.isascii() else mm

    # Ano modelo
    am = _find_line_value(lines, "ANO MODELO", "ANO/MODELO", "ANO DO MODELO")
    if am:
        am_clean = re.sub(r"\s+", "", am)
        m2 = re.search(r"(\d{4})/(\d{4})", am_clean)
        if m2:
            out["anoModelo"] = f"{m2.group(1)}/{m2.group(2)}"
        else:
            m2 = re.search(r"(\d{4})\s*/\s*(\d{4})", am)
            if m2:
                out["anoModelo"] = f"{m2.group(1)}/{m2.group(2)}"

    cor = _find_line_value(
        lines,
        "COR PREDOMINANTE",
        "COR",
        "COR DO VEÍCULO",
        "COR DO VEICULO",
    )
    if cor:
        cor = re.sub(r"\s+", " ", cor).strip()
        if len(cor) < 40 and not re.search(r"^\d+$", cor):
            out["cor"] = cor.upper()

    # Fallback marca/modelo: linha com padrão MARCA/MODELO no meio do texto
    if "marcaModelo" not in out:
        m = re.search(
            r"([A-Z]{2,15})\s*/\s*([A-Z0-9][A-Z0-9\s\.\-]{2,40})",
            raw,
            re.I,
        )
        if m and len(m.group(0)) < 60:
            out["marcaModelo"] = f"{m.group(1).upper()}/{m.group(2).upper().strip()}"

    return out


def merge_into_veiculo(existing: dict, parsed: dict) -> dict[str, tuple[str, str]]:
    """Retorna {campo: (antes, depois)} para log."""
    changes: dict[str, tuple[str, str]] = {}
    field_map = [
        ("marcaModelo", "marcaModelo"),
        ("anoModelo", "anoModelo"),
        ("chassi", "chassi"),
        ("renavam", "renavam"),
        ("cor", "cor"),
    ]
    for json_key, src_key in field_map:
        if src_key not in parsed:
            continue
        newv = parsed[src_key].strip()
        if not newv:
            continue
        oldv = (existing.get(json_key) or "").strip()
        if oldv != newv:
            existing[json_key] = newv
            changes[json_key] = (oldv, newv)
    if "placa_doc" in parsed:
        newp = format_placa_hyphen(parsed["placa_doc"])
        oldp = (existing.get("placa") or "").strip().upper()
        if compact_placa(newp) != compact_placa(oldp):
            changes["_placa_doc_diff"] = (oldp, newp)
    return changes


def main() -> None:
    ap = argparse.ArgumentParser(description="Sincroniza veiculos.json com CRLV em PDF nas pastas.")
    ap.add_argument("--dry-run", action="store_true", help="Não grava veiculos.json")
    ap.add_argument("--placa", help="Só esta placa (com ou sem hífen)")
    args = ap.parse_args()

    if not DBV.is_file():
        print("Não encontrado:", DBV, file=sys.stderr)
        sys.exit(1)

    data = json.loads(DBV.read_text(encoding="utf-8"))
    veiculos: list[dict] = data.get("veiculos") or []

    roots: list[Path] = []
    dr = load_documentos_raiz()
    if dr:
        roots.append(dr)
    if VEIC_DIR.is_dir():
        roots.append(VEIC_DIR)

    if not roots:
        print("Nenhuma pasta configurada (documentosRaiz ou veiculos/).", file=sys.stderr)
        sys.exit(1)

    index = collect_crlv_index(roots)
    if not index:
        print("Nenhum PDF de CRLV indexado.", file=sys.stderr)
        sys.exit(1)

    filtro = compact_placa(args.placa) if args.placa else None
    total_changes = 0
    not_found: list[str] = []

    for v in veiculos:
        placa = v.get("placa") or ""
        key = compact_placa(placa)
        if filtro and key != filtro:
            continue
        pdf = index.get(key)
        if not pdf:
            not_found.append(placa)
            continue
        try:
            text = extract_pdf_text(pdf)
        except Exception as e:
            print(f"[erro] {placa} <- {pdf}: {e}", file=sys.stderr)
            continue
        parsed = parse_crlv(text)
        if not parsed:
            print(f"[aviso] {placa}: nenhum campo extraído de {pdf.name}", file=sys.stderr)
            continue
        ch = merge_into_veiculo(v, parsed)
        if ch:
            total_changes += 1
            print(f"{placa} <- {pdf}")
            for k, (o, n) in ch.items():
                print(f"  {k}: {o!r} -> {n!r}")

    if not_found and not filtro:
        print("\nSem PDF indexado para:", ", ".join(not_found))
    elif not_found and filtro:
        print("Sem PDF para placa", filtro, file=sys.stderr)
        sys.exit(1)

    if args.dry_run:
        print("\n[dry-run] não gravado (nenhuma alteração persistida).")
        return

    if total_changes:
        data["atualizadoEm"] = date.today().isoformat()
        DBV.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"\nGravado: {DBV} ({total_changes} veículo(s) alterados)")
    else:
        print("Nenhuma alteração aplicada.")


if __name__ == "__main__":
    main()
