---
name: sync-ipva-licenciamento
description: >-
  Syncs IPVA and Licenciamento debits from DETRAN SC into database/parceiro-despesas.json
  for partner accountability. Uses tool .cursor/tools/detran-sc/.
  Use when syncing IPVA, licenciamento, débitos proprietário DETRAN, or before relatorio-prestacao-contas.
---

# Sync IPVA / licenciamento — DETRAN SC → parceiro-despesas.json

Skill de **negócio**: trazer **IPVA** e **Licenciamento** do DETRAN SC para `database/parceiro-despesas.json` (despesas do **parceiro/dono**). Alimenta **relatorio-prestacao-contas**.

**Execução técnica** (auth, API, classificação de `debitos[]`): tool **`.cursor/tools/detran-sc/`** — ler [README.md](../../tools/detran-sc/README.md) e [ipva-licenciamento.md](../../tools/detran-sc/ipva-licenciamento.md) antes de correr a CLI.

## DETRAN por UF — usa as duas tools (SC + RS)

Esta skill cobre **ambos os DETRANs**, roteando por **`ufRegistro`** do veículo:

- `SC` ou ausente → tool **`.cursor/tools/detran-sc/`** (fluxo com ticket/captcha desta skill).
- `RS` → tool **`.cursor/tools/detran-rs/`** (CLI `sync-detran-rs`, uma chamada GET sem captcha; grava IPVA/Licenciamento em `parceiro-despesas.json` igual ao SC).

O CLI `sync-ipva-licenciamento` roteia sozinho: `--placa` de veículo RS é delegada à tool RS; na frota, processa SC e depois RS. Guarda-chuvas: **`sync-detran-sc`** (infrações + IPVA/Lic. SC) e **`sync-detran-rs`** (tudo do RS).

## Quando usar

- Utilizador pede **sync IPVA / licenciamento / débitos DETRAN do parceiro**.
- Antes de **relatorio-prestacao-contas** — validar despesas do mês.
- **Não** usar para multas de locatário → skill **sync-infracoes**.

## Semântica (resumo)

Mesma resposta API que **sync-infracoes**, destinos diferentes:

| Tipo em `debitos[]` | Esta skill | sync-infracoes |
|---------------------|------------|----------------|
| Multa / infração | ❌ ignorar | ✅ cliente-despesas |
| IPVA | ✅ parceiro-despesas | ❌ |
| Licenciamento | ✅ parceiro-despesas | ❌ |

## Sem placa = TODOS os veículos (frota)

`sync-ipva-licenciamento` **sem `--placa` processa todos os veículos ativos** do `database`, roteando por UF.

### RS (`ufRegistro="RS"`) — automático

Uma chamada GET por veículo, **sem captcha** (precisa de `DETRAN_RS_AUTH`/`DETRAN_RS_USER_ID`). Já roda dentro de `sync-ipva-licenciamento` (frota) e em `sync-detran-rs`.

### SC — varredura 100% automática via solver (confirmado 28/06/2026)

O `requisitar-consulta` exige um **captcha Cloudflare Turnstile** (token `c`, modo
`execute`, `action=consulta_dossie_veiculo`). O **solver** resolve isso num Chrome
real via CDP e **varre a frota SC inteira automaticamente** (uma passada cobre
infrações **e** IPVA/Licenciamento):

```bash
npx tsx scripts/detranSolver.ts            # frota SC ativa inteira
npx tsx scripts/detranSolver.ts --placa PLACA --dry-run
```

Único passo manual: o **login gov.br** na janela do Chrome (sessão persiste no
perfil dedicado). Detalhes na tool `.cursor/tools/detran-sc/` (reference → "Solver").

Caminhos alternativos (sem solver):
- **Uma placa logo após consultar no portal:** `sync-ipva-licenciamento --placa PLACA` reaproveita o ticket pendente.
- **Lote por captura no browser:** `scripts/capturarDetranConsole.js` + `baixarDetranData()` → `processarDetranTickets.ts --data …`.

Basta `DETRAN_SC_AUTH` (token válido — `HTTP 401` = recapturar) e `DETRAN_SC_EMPRESA`. Rede com interceção TLS: `DETRAN_SC_TLS_INSECURE=1`.

### Uma placa só (`--placa`)

`sync-ipva-licenciamento --placa PLACA` tenta consultar sozinho (ok se houver pendência); senão `--ticket <t>` ou `--json arquivo.json`. Placa RS é roteada sozinha para a tool RS.

## Fluxo do agente

1. Confirmar variáveis de ambiente: `DETRAN_SC_AUTH`/`DETRAN_SC_EMPRESA` (SC) e `DETRAN_RS_AUTH`/`DETRAN_RS_USER_ID` (RS, se houver placas RS).
2. **Sem placa (frota / todos os veículos):** RS roda automático; **SC roda automático pelo solver** (`npx tsx scripts/detranSolver.ts` — só pede o login gov.br aberto). Alternativa: captura no browser (`baixarDetranData()` → `processarDetranTickets.ts --data …`).
3. **Com placa:** consulte a placa no portal e rode `sync-ipva-licenciamento --placa PLACA` (reaproveita o pendente) ou `--ticket <t>`. Placa RS roteada sozinha.
4. Revisar `relatorios/sync/_sync_ipva_licenciamento.json`.
5. **Espelhar no Rastreame (tela Manutenção):** `sync-manutencao` (push). Toda despesa de parceiro vai para a tela **Manutenção** (tipo `OUTROS`); idempotente.
6. Lançamento manual pontual → **cadastro-despesa** (`gravar-despesa`).

## CLI

```bash
# Frota SC (automático, solver — só com o login gov.br aberto; cobre infrações + IPVA/lic):
npx tsx scripts/detranSolver.ts
# Frota SC (alternativa por captura no browser):
npx tsx scripts/processarDetranTickets.ts --data "%USERPROFILE%\Downloads\detran_data.json"
# Frota RS (automático):
npx tsx src/run.ts sync-detran-rs

# Uma placa (após consultar no portal):
npx tsx src/run.ts sync-ipva-licenciamento --placa MKV-6268
npx tsx src/run.ts sync-ipva-licenciamento --dry-run --placa MKV-6268 --ticket <t>

# espelho no Rastreame (tela Manutenção)
npx tsx src/run.ts sync-manutencao --categoria IPVA --dry-run
```

## Destino

| Campo | Valor |
|-------|-------|
| `categoria` | `IPVA` ou `Licenciamento` |
| `origem` | `detran-sc/debitos/{PLACA}/{categoria}/{id}` |
| Ficheiro | `database/parceiro-despesas.json` |

## IPVA: cota única + parcelas (ambas gravadas)

O DETRAN devolve o **mesmo IPVA** em duas formas: **cota única** e **3 parcelas**. O sync grava **todas** (cada uma com `origem`/`id` próprio e vencimento). **São alternativas — nunca somar as duas.** A escolha de qual cobrar (e se o parceiro paga ou a locadora paga e cobra) é feita **com seletor** na skill **relatorio-prestacao-contas** (ver secção "IPVA e Licenciamento" lá).

## Idempotência

- **Chave:** `origem` = `detran-sc/debitos/{PLACA}/{categoria}/{id}` (o `{id}` é o `idDebito`, único por débito — cota única e cada parcela têm `id` distinto, por isso coexistem).
- Reexecutar sync **atualiza** débitos existentes; **não duplica**.
- Ver [`_idempotencia.md`](../_idempotencia.md).

Detalhes: [reference.md](reference.md) e `.cursor/tools/detran-sc/`.

## Rastreame (tela Manutenção)

Como toda despesa de parceiro, IPVA/Licenciamento são espelhados na tela **Manutenção** do Rastreame via **`sync-manutencao`** (push idempotente). O rastreável é resolvido pela placa (`rastreameRastreavelKey` em `veiculos.json`). Ver tool **`.cursor/tools/rastreame/`**.

## Skills relacionadas

- **sync-infracoes** — multas → `cliente-despesas.json` (espelho em **Gastos Gerais** via `sync-gastos-gerais`).
- **relatorio-prestacao-contas** — consome `parceiro-despesas.json`.
- **cadastro-despesa** — CRUD manual de despesas do parceiro.
