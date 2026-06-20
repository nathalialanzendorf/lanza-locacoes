# Cursor Agent Skills (projeto worklanza)

Skills em `.cursor/skills/<nome>/SKILL.md` são descobertas pelo Cursor neste repositório.

| Pasta | Função |
|-------|--------|
| `contrato` | Preencher LOCATÁRIO no modelo Word v3 (fluxo manual / XML). |
| `cadastrar-cliente` | CNH + comprovante → `database/clientes.json` (+ opcional rastreame). |
| `cadastrar-despesa` | Lançamento manual → `database/despesas.json`. |
| `cadastrar-veiculo` | CRLV + Fipe + proprietário → `veiculos.json` / vínculos. |
| `gerar-contrato` | Contrato completo `.docx`/`.pdf` via `scripts/gerar_contrato.py`. |
| `importar-boletos-seguro` | PDFs em `despesas/.../Seguro` → despesas de seguro. |
| `relatorio-prestacao-contas` | Relatório mensal → `prestação de contas/`. |

Scripts Python usam a **raiz do repositório** como `parents[4]` a partir de `scripts/*.py`.
