# Relatório de cobranças

Siga a skill **relatorio-cobrancas**.

## Parâmetros (0 a 3 — omitir = **todos** nessa dimensão)

| Parâmetro | Omitir significa |
|---|---|
| **tipo-despesa** | todos os tipos |
| **cliente** | todos os clientes |
| **veículo** | todos os veículos |

Tipos-despesa: `pagamento-semanal` · `renegociacao` · `infracoes` · `pedagio` · `estacionamento-rotativo` · `manutencao`

Cliente e veículo são **mutuamente exclusivos**. Pode informar 1, 2, 3 ou **nenhum** parâmetro.

### Exemplos

```
/relatorio-cobrancas                                    → tudo
/relatorio-cobrancas pagamento-semanal                  → tipo + todos clientes/veículos
/relatorio-cobrancas infracoes Daniel Damasceno         → tipo + cliente
/relatorio-cobrancas pedagio RAH-4F54                    → tipo + veículo
/relatorio-cobrancas Daniel Damasceno                    → cliente + todos tipos
/relatorio-cobrancas RAH-4F54                            → veículo + todos tipos
```

## CLI

| Parâmetro | Flag |
|---|---|
| tipo-despesa | 1º arg ou `--tipo` |
| cliente | `--cliente "NOME"` |
| veículo | `--placa PLACA` |

```bash
npx tsx src/run.ts relatorio-cobrancas --listar
npx tsx src/run.ts relatorio-cobrancas pagamento-semanal --cliente "Daniel Damasceno"
npx tsx src/run.ts relatorio-cobrancas --placa RAH-4F54
```

## Fluxo

1. Interpretar parâmetros do utilizador (0–3).
2. `--listar` para conferir alvos; depois gerar.
3. **pagamento-semanal**: tabela semanal-atraso + WhatsApp (`--dia` padrão 3).
4. Criar **canvas** a partir dos JSON em `relatorios/_tmp/cobrancas/`.

Modo legado por placa: `semanal`, `semanal-atraso`, `estacionamento`, `multa` — exige `--placa`.
