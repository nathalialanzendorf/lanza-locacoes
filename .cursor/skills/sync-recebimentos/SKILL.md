---
name: sync-recebimentos
description: >-
  Syncs Rastreame Gastos Gerais (OUTROS) with database/cliente-despesas.json.
  Local DB is source of truth. Idempotent pull/push. Use for sync recebimentos,
  gastos gerais, cliente-despesas Rastreame.
---

# Sync recebimentos — Rastreame ↔ cliente-despesas.json

Sincroniza **Gastos Gerais** (tipo `OUTROS`) do Rastreame com `database/cliente-despesas.json`.

## CLI

> Comando: **`sync-gastos-gerais`** (alias legado: `sync-recebimentos`). O nome da skill permanece `sync-recebimentos`.

```bash
npx tsx src/run.ts sync-gastos-gerais
npx tsx src/run.ts sync-gastos-gerais --dry-run
npx tsx src/run.ts sync-gastos-gerais --pull-only
npx tsx src/run.ts sync-gastos-gerais --push-only
```

## Idempotência

- **Pull:** `rastreameId` ou chave `RAST-{id}`; respeita edição local mais recente.
- **Push:** PUT por `rastreameId`; antes de POST procura duplicata (`info + motorista + rastreável`).
- Reexecutar é seguro — ver [`_idempotencia.md`](../_idempotencia.md).

## Skills relacionadas

- **cadastro-recebimento**, **rastreame-site**, **gravar-cliente-despesa**
