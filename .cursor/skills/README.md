# Cursor Agent Skills (projeto worklanza)

Skills em `.cursor/skills/<nome>/SKILL.md` são descobertas pelo Cursor neste repositório.

**Pastas operacionais:** `config/lanza_paths.json` e `.cursor/rules/lanza-diretorios.mdc`.

**Tools (auth/API):** `.cursor/tools/` — ver `.cursor/rules/lanza-tools.mdc`. Skills de sync DETRAN **usam** a tool `detran-sc/`; Rastreame é só tool (skills de cadastro delegam).

| Pasta | Função |
|-------|--------|
| `cadastro-cliente` | CRUD locatário → `clientes.json` (+ Rastreame via tool). |
| `cadastro-veiculo` | CRUD veículo → `veiculos.json`. |
| `cadastro-despesa` | CRUD débitos parceiro → `parceiro-despesas.json` (inclui rastreador fixo R$ 50/mês via `gravar-rastreador`). |
| `cadastro-recebimento` | CRUD recebimentos Rastreame (tool). |
| `cadastro-contrato` | CRUD contrato Word/PDF + `contratos.json`. |
| `relatorio-encerramento-contrato` | Acerto de encerramento (sem gravar contrato). |
| `relatorio-prestacao-contas` | Relatório mensal parceiro. |
| **`sync-infracoes`** | Multas/infrações DETRAN → `cliente-despesas.json` (tool DETRAN). |
| **`sync-ipva-licenciamento`** | IPVA/licenciamento DETRAN → `parceiro-despesas.json` (tool DETRAN). |
| **`sync-pedagios`** | Passagens em aberto pedagiodigital.com → `cliente-despesas.json` (tool Pedágio Digital). |
| `sync-seguro` | PDFs seguro → `parceiro-despesas.json`. |
| **`sync-recebimentos`** | Gastos Gerais Rastreame ↔ `cliente-despesas.json`. |
| **`sync-cliente`** | Clientes (motoristas) Rastreame ↔ `clientes.json`. |
| **`sync-veiculo`** | Veículos (rastreáveis) Rastreame ↔ `veiculos.json`. |
| `importar-boletos-seguro` | Lote boletos seguro. |

**Idempotência:** ver [`.cursor/skills/_idempotencia.md`](.cursor/skills/_idempotencia.md) — toda skill de sync deve ser reexecutável sem duplicar.
| `renegociar-debitos` | Renegociação Rastreame (tool). |

**CLI:** `npx tsx src/run.ts …` na raiz do repo.
