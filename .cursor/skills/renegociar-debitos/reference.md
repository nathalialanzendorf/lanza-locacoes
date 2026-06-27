# Renegociar débitos — referência técnica

## Schema JSON de entrada

```json
{
  "negociacaoCodigo": "1",
  "gastosIds": [592, 580, 575],
  "motoristaKey": "28",
  "rastreavelKey": "110",
  "parcelas": [
    { "numero": 1, "totalParcelas": 8, "valor": 150, "data": "2026-07-28" },
    { "numero": 2, "totalParcelas": 8, "valor": 150, "data": "2026-08-05" },
    { "numero": 3, "totalParcelas": 8, "valor": 150, "data": "2026-08-12" },
    { "numero": 4, "totalParcelas": 8, "valor": 150, "data": "2026-08-19" }
  ]
}
```

| Campo | Obrigatório | Descrição |
|-------|-------------|-----------|
| `negociacaoCodigo` | sim | Código **X** em `[NEGOCIADO X]`. |
| `gastosIds` | sim | IDs dos gastos existentes a marcar. |
| `motoristaKey` | sim | `motorista.key` no Rastreame. |
| `rastreavelKey` | sim | `rastreavel.key` no Rastreame. |
| `parcelas` | sim | Lista de parcelas novas. |
| `parcelas[].numero` | sim | Parcela **a** em `axb`. |
| `parcelas[].totalParcelas` | sim | Total **b** em `axb`. |
| `parcelas[].valor` | sim | Valor da parcela (`total` no POST). |
| `parcelas[].data` | sim | Vencimento `YYYY-MM-DD` ou ISO. |

## Comandos CLI

```bash
# Listar débitos em aberto (sem [NEGOCIADO], total > 0)
npx tsx src/run.ts renegociar-debitos resumo --motorista 28 --rastreavel 110

# Dry-run (preview PUT/POST)
npx tsx src/run.ts renegociar-debitos relatorios/_renegociacao.json

# Executar no Rastreame
npx tsx src/run.ts renegociar-debitos relatorios/_renegociacao.json --execute
```

## API Rastreame

Base: `https://rastreame.com.br/keek/rest/gasto/`

### GET gasto (corpo completo para PUT)

```
GET /keek/rest/gasto/{id}
```

### PUT — marcar negociado

Alterar apenas `info`:

```
[NEGOCIADO {X}] {info original sem ATRASADO}
```

> ⚠️ **Ao incluir `[NEGOCIADO X]`, remover a tag `ATRASADO`** do `info`.
> Ex.: `ATRASADO Pagamento semanal - Sábado 27` → `[NEGOCIADO 2] Pagamento semanal - Sábado 27`.
> Implementado em `infoMarcadaNegociada` / `removerTagAtrasado` (`src/lib/rastreame/renegociacao.ts`).

Corpo: espelhar resposta do GET, com `info` atualizado (incluir `id`, `dataCriacao`, `lockKey`, etc.).

### POST — nova parcela

Corpo mínimo (como no site):

```json
{
  "total": 150,
  "rastreavel": { "key": "110" },
  "tipo": { "key": "DOCUMENTACAO" },
  "motorista": { "key": "28" },
  "info": "ATRASADO Pagamento negociação - 4x8",
  "data": "2026-08-05T02:59:00.000Z"
}
```

**Nota:** `data` em ISO; a CLI converte `YYYY-MM-DD` para 23:59 America/Recife.

## Diferença vs cadastro-recebimento

| Aspecto | cadastro-recebimento | renegociar-debitos |
|---------|----------------------|-------------------|
| Tipo novo lançamento | `OUTROS` | `DOCUMENTACAO` |
| Texto parcela | `ATRASADO - Pagamento semanal - …` | `ATRASADO Pagamento negociação - axb` |
| Débitos antigos | PUT remove ATRASADO / ajusta total | PUT prefixa `[NEGOCIADO X]` |

## Integração com relatorio-encerramento-contrato

- **relatorio-encerramento-contrato**: calcula multas, semanas em aberto, diárias e caução a partir do contrato Word + `database/cliente-despesas.json`.
- **renegociar-debitos**: opera sobre **IDs já lançados no Rastreame**; o operador mapeia valores do fechamento para `gastosIds` e parcelas, ou lança manualmente antes.
