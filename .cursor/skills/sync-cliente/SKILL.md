---
name: sync-cliente
description: >-
  Syncs Rastreame motoristas with database/clientes.json. Local DB is source of
  truth. Idempotent pull/push. Use for sync cliente, sync motoristas, clientes Rastreame.
---

# Sync cliente — Rastreame ↔ clientes.json

Sincroniza clientes (motoristas) entre o Rastreame e `database/clientes.json`.

## Regra de dados (igual à `cadastro-cliente`)

- **Só os campos nativos** do Rastreame são sincronizados: `nome`, `cpf`, `cnh` (número), `categoriaCnh`, `vencimentoCnh`, `contato` (celular/e-mail).
- O campo **`observacao` do Rastreame NÃO é usado** — não é lido na importação nem escrito no push. (Observações já existentes no site são preservadas, mas ignoradas.)
- Endereço, RG/órgão, nascimento, filiação, nº espelho, órgão emissor/UF, 1ª habilitação, EAR e observações **ficam só na database** e são **preservados** no merge — o pull é **não-destrutivo** (só preenche lacunas; usar `--force-pull` para deixar o Rastreame sobrescrever).

## CLI

> O comando continua `sync-motoristas` (entidade do Rastreame = *motorista*).

```bash
npx tsx src/run.ts sync-motoristas
npx tsx src/run.ts sync-motoristas --dry-run --pull-only
```

| Opção | Efeito |
|-------|--------|
| `--dry-run` | Simula sem gravar local nem chamar POST/PUT |
| `--pull-only` | Só importa Rastreame → `clientes.json` |
| `--push-only` | Só exporta `clientes.json` → Rastreame (campos nativos) |
| `--force-pull` | Rastreame sobrescreve o local (espelho exato) |

> Por defeito: push (local → Rastreame) e depois pull (Rastreame → local).

## Importação completa (pull)

- O pull busca o **detalhe** de cada motorista (a listagem traz só resumo) e importa os campos nativos.
- Casa registos por **`rastreameMotoristaKey` → CPF → CNH → nome normalizado** (o nome evita duplicar quem já existe localmente sem CPF/CNH casado).
- Cliente ausente no Rastreame é **inativado** localmente (não apagado).

## Push (campos nativos)

- PUT/POST enviam **apenas os campos nativos**; `observacao` nunca é enviada.
- Antes de POST usa `findMotorista(cnh, nome)` para não duplicar.
- **Inativação só local:** clientes com `ativo === false` **não** são enviados ao Rastreame (push pula inativos). O pull continua atualizando o local com o dado do Rastreame, independente do status. Ver regra em `.cursor/rules/lanza-tools.mdc`.

## Idempotência

Reexecutar é seguro — ver [`_idempotencia.md`](../_idempotencia.md).

## Skills relacionadas

- **cadastro-cliente** (mesma regra de dados), **importar-clientes-rastreame**.
- Tool **Rastreame** (`.cursor/tools/rastreame/`).
