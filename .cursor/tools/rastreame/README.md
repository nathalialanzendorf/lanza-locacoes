# Tool — Rastreame (rastreame.com.br)

Integração HTTP com [rastreame.com.br](https://rastreame.com.br/). Execução via CLI na **raiz do repo** (`npm install`).

Skills que **usam** esta tool: `cadastro-cliente`, `cadastro-recebimento`, `renegociar-debitos`, e todos os syncs que espelham despesas no Rastreame (regras de negócio ficam nas skills).

## Princípio: onde cada despesa é gravada no Rastreame

Toda skill de ingestão (`sync-infracoes`, `sync-pedagios`, `sync-ipva-licenciamento`, `sync-seguro`, `cadastro-despesa`/rastreador) grava no `database/` **e** espelha no Rastreame, conforme o tipo:

| Tipo de despesa | Base local | Tela Rastreame | Comando de push |
|-----------------|-----------|----------------|-----------------|
| **Cliente / locatário** (infração, pedágio, locação) | `cliente-despesas.json` | **Gastos Gerais** (`/keek/rest/gasto`) | `sync-gastos-gerais` (push) |
| **Parceiro / dono** (Seguro, Rastreador, IPVA, Licenciamento, Manutenção) | `parceiro-despesas.json` | **Manutenção** (`/keek/rest/manutencao`) | `sync-manutencao` (push) |

## De-para do `Tipo` em Gastos Gerais (despesa de cliente)

Mapeamento **canônico** entre a categoria interna (`cliente-despesas.json`) e o **Tipo**
do gasto no Rastreame (Gastos Gerais). Usar este de-para ao gravar/listar/espelhar:

| Tipo (Rastreame) | O que é | Categoria interna |
|------------------|---------|-------------------|
| **DOCUMENTACAO** | Renegociações | `Renegociação` |
| **OUTROS** | Cobrança semanal e caução | `Locação semanal`, `Caução` |
| **PEDAGIO** | Pedágio e estacionamento rotativo | `Pedágio`, `Estacionamento` |
| **MULTA** | Infrações | `Infração` |
| **ALIMENTACAO** | Manutenção de responsabilidade do cliente (troca de óleo, troca de pneu, acionamento de franquia, lavação) | `Manutenção` |

> Skills `cadastro-recebimento` e `renegociar-debitos` referenciam este de-para ao listar
> as **despesas do cliente** (coluna `Tipo`).

## Tags no `info` (`ATRASADO` / `[NEGOCIADO X]`)

- **`ATRASADO`** — débito de cliente em aberto/atraso.
- **`[NEGOCIADO X]`** — débito que entrou numa renegociação (código **X**).

> **Regra (fonte única nas skills):** a regra da tag `ATRASADO` vive na skill
> **`cadastro-recebimento`**; a tag `[NEGOCIADO X]` (que **remove `ATRASADO`**) vive na
> skill **`renegociar-debitos`**. Implementação: `infoMarcadaNegociada` / `removerTagAtrasado`
> em `src/lib/rastreame/renegociacao.ts`.

## Autenticação (variáveis de ambiente do utilizador)

**Não** grave credenciais em `.env`. Defina no Windows (utilizador) ou no perfil do shell:

| Variável | Uso |
|----------|-----|
| `RASTREAME_AUTH` | JWT → header `x-r2f-auth` (prioridade). Renovar via DevTools → Network. |
| `RASTREAME_LOGIN` + `RASTREAME_SENHA` | Alternativa: login automático para obter token. |
| `RASTREAME_TLS_INSECURE=1` | Só diagnóstico TLS — pode ir no `.env` (não é credencial). |

```powershell
[Environment]::SetEnvironmentVariable("RASTREAME_AUTH", "<token>", "User")
# ou
.\scripts\set-rastreame-auth-user-env.ps1 -Token "<token>"
```

**Login automático** (com `RASTREAME_LOGIN` + `RASTREAME_SENHA` definidos): obtém o JWT e
opcionalmente grava-o em `RASTREAME_AUTH` (utilizador):

```powershell
npx tsx src/run.ts rastreame login          # mostra o token
npx tsx src/run.ts rastreame login --save   # grava em RASTREAME_AUTH (utilizador)
```

Feche e reabra o terminal (ou o Cursor) após alterar variáveis de utilizador.

**Nunca** versionar tokens no Git.

## Módulos (`src/lib/rastreame/`)

| Módulo | Função |
|--------|--------|
| `auth.ts` | Token, headers |
| `motorista.ts` | `/keek/rest/motorista` |
| `gasto.ts` | `/keek/rest/gasto` (Gastos Gerais — despesa de cliente) |
| `manutencao.ts` | `/keek/rest/manutencao` (Manutenção — despesa de parceiro) |
| `manutencaoSync.ts` | Push `parceiro-despesas.json` → Manutenção (idempotente) |
| `recebimentosSync.ts` | Sync `cliente-despesas.json` ↔ Gastos Gerais |
| `rastreavel.ts` | `/keek/rest/rastreavel` |
| `renegociacao.ts` | Marcação `[NEGOCIADO X]` |

## Comandos CLI

```bash
npx tsx src/run.ts rastreame login [--save]
npx tsx src/run.ts rastreame check "<cnh>" ["nome"]
npx tsx src/run.ts rastreame add "<cliente.json>"
npx tsx src/run.ts importar-clientes-rastreame [--dry-run]

npx tsx src/run.ts rastreame-gastos list [--page 0] [--size 50]
npx tsx src/run.ts rastreame-gastos post "<corpo.json>"
npx tsx src/run.ts rastreame-gastos put <id> "<corpo.json>"

npx tsx src/run.ts sync-gastos-gerais [--dry-run] [--push-only] [--pull-only]   # alias: sync-recebimentos
npx tsx src/run.ts sync-manutencao [--placa PLACA] [--categoria CAT] [--dry-run]

npx tsx src/run.ts rastreame-lancar-semanal [--inicio YYYY-MM-DD] [--fim YYYY-MM-DD] [--execute]

npx tsx src/run.ts renegociar-debitos resumo --motorista <key> --rastreavel <key>
npx tsx src/run.ts renegociar-debitos "<entrada.json>" [--execute]
```

## Mapa skill → comando

| Skill | Objetivo | Comando |
|-------|----------|---------|
| (auth) | Login automático / token | `rastreame login [--save]` |
| cadastro-cliente | Verificar motorista | `rastreame check` |
| cadastro-cliente | Criar motorista | `rastreame add` |
| cadastro-recebimento | Listar / criar / editar gasto | `rastreame-gastos list\|post\|put` |
| sync-infracoes / sync-pedagios | Espelhar despesa de cliente → Gastos Gerais | `sync-gastos-gerais` |
| sync-ipva-licenciamento / sync-seguro / cadastro-despesa | Espelhar despesa de parceiro → Manutenção | `sync-manutencao` |
| importar clientes | Rastreame → `clientes.json` | `importar-clientes-rastreame` |
| lançamento semanal | Contratos ativos → gasto OUTROS | `rastreame-lancar-semanal` |
| renegociar-debitos | Resumo e execução | `renegociar-debitos` |

## Erros comuns

- **401/403:** token expirado → renovar `RASTREAME_AUTH`.
- **404 em list:** ajustar URL em `gasto.ts` conforme XHR na [listagem de gastos](https://rastreame.com.br/#/gastos/list).
- **Antes de POST gasto:** verificar duplicado por `info` (skill cadastro-recebimento).

## Extensão

Novo endpoint: função em `src/lib/rastreame/`, subcomando em `run.ts`, linha nesta tabela.
