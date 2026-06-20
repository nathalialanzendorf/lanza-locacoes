---
name: importar-boletos-seguro
description: >-
  Reads insurance bill PDFs under despesas/<month>/Seguro, extracts vehicle
  plate and premium amount, and writes Seguro expenses to database/despesas.json.
  Use when importing boletos de seguro, lote de seguros, or after adding PDFs
  to the Seguro folder.
---

# Importar Boletos de Seguro

Lê **boletos de seguro** (PDF), extrai **placa** e **valor**, grava em `database/despesas.json` (categoria `Seguro`). Alimenta **relatorio-prestacao-contas**.

## Uso

- Pasta típica: `despesas/06 Junho/Seguro` (ajustar mês).
- Preferir **um arquivo por veículo** (`.pdf`); se existir `.jpg` e `.pdf` com o mesmo nome-base, usar só o PDF.

## Extração

| Campo | Onde |
|-------|------|
| `placa` | `PLACA(S): ...` e/ou nome do arquivo |
| `valor` | `( = ) Valor do Documento` / `(R$ xx,xx)` por placa |
| `data` | Vencimento DD/MM/AAAA |
| `competencia` | `CONTRIBUIÇÃO DO MÊS MM/AA` → `MM/AAAA` |

## Gravar

Montar lista JSON e executar:

```bash
python ".cursor/skills/importar-boletos-seguro/scripts/gravar_despesas.py" "despesas/_boletos_tmp.json"
```

Formato do JSON (array):

```json
[
  {"placa":"AVU6740","valor":74.85,"data":"10/06/2026","competencia":"06/2026",
   "origem":"06 Junho/Seguro/AVU6740 - GOL.pdf"}
]
```

`origem` deve ser **caminho relativo à raiz do repo** (ou estável) para dedupe na reimportação.

## Critério de conclusão

- Um registro por veículo sem dobrar jpg+pdf.
- `veiculoId` resolvido ou `null` com aviso.

## Skills relacionadas

- **relatorio-prestacao-contas**, **cadastrar-veiculo**
