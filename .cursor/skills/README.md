# Cursor Agent Skills (projeto worklanza)

Skills em `.cursor/skills/<nome>/SKILL.md` são descobertas pelo Cursor neste repositório.

**Pastas operacionais (contratos, documentos, prestação de contas no disco):** ver `config/lanza_paths.json` e a regra `.cursor/rules/lanza-diretorios.mdc` (padrão `D:\Dropbox\Aluguel Carros` e `...\Financeiro`).

| Pasta | Função |
|-------|--------|
| `contrato` | Preencher LOCATÁRIO no modelo Word v3 (fluxo manual / XML). |
| `cadastrar-cliente` | CNH + comprovante → `database/clientes.json` (+ opcional rastreame). |
| `cadastrar-despesa` | Lançamento manual → `database/despesas.json`. |
| `cadastrar-veiculo` | CRLV + Fipe + proprietário → `veiculos.json` / vínculos. |
| `gerar-contrato` | Contrato completo `.docx`/`.pdf` via `scripts/gerar_contrato.py` (saída em `contratosDir` do JSON de config). |
| `importar-boletos-seguro` | PDFs em `seguroComprovantesDir` (`config/lanza_paths.json`, padrão `Proteção Veicular\Comprovantes\2026`) → `despesas.json`. |
| `relatorio-prestacao-contas` | Relatório mensal → pasta Financeiro (ver `lanza_paths.json`). |

Scripts Python usam a **raiz do repositório** como `parents[4]` a partir de `scripts/*.py`.
