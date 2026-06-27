---
name: sync-veiculo
description: >-
  Syncs Rastreame rastreáveis (vehicles) with database/veiculos.json. Local DB
  is source of truth. Idempotent pull/push. Use for sync veículo, sync rastreáveis, veículos Rastreame.
---

# Sync veículo — Rastreame ↔ veiculos.json

## CLI

> O comando continua `sync-rastreaveis` (entidade do Rastreame = *rastreável*).

```bash
npx tsx src/run.ts sync-rastreaveis
npx tsx src/run.ts sync-rastreaveis --dry-run --push-only
```

## Idempotência

- **Pull:** `rastreameRastreavelKey` → `placa`.
- **Push:** PUT por key; antes de POST procura rastreável remoto com a mesma placa.
- Reexecutar é seguro — ver [`_idempotencia.md`](../_idempotencia.md).

## Inativação só local

- Veículos com `ativo === false` **não** são enviados ao Rastreame (push pula inativos; nunca empurramos inativação). O pull continua atualizando o local independente do status. O passo FIPE também ignora inativos. Ver regra em `.cursor/rules/lanza-tools.mdc`.

## Skills relacionadas

- **cadastro-veiculo**, **rastreame-site**
