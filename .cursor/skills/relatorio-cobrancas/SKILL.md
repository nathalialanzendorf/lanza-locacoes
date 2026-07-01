---
name: relatorio-cobrancas
description: >-
  Gera mensagens de cobrança prontas para WhatsApp a partir de templates e
  database/cliente-despesas.json. Action /relatorio-cobrancas com parâmetros
  tipo e escopo (cliente, veículo/placa ou todos). Tipos: pagamento-semanal,
  renegociacao, infracoes, pedagio, estacionamento-rotativo, manutencao.
  Use para cobrança WhatsApp, multa, pedágio, rotativo e pagamento semanal.
---

# Relatório de cobranças (WhatsApp)

Gera o **texto da cobrança** pronto para colar no WhatsApp. Skill **só leitura** (imprime e salva `.txt`); não altera bases.

> **Veículos particulares** (`"particular": true` em `veiculos.json`) **não geram cobrança** — não são de locação (sem locatário). O CLI recusa a placa com erro claro.

Cada mensagem tem um **modelo próprio** em `templates/cobrancas/`. O CLI lê o template, troca os campos `{...}` por dados do veículo/despesa e salva em `relatorios/cobrancas/`.

## Tipos de cobrança

| Tipo | Template | Dados |
|---|---|---|
| 💰 **semanal** | `semanal-{1..4}-*.txt` | placa + marca/modelo (`veiculos.json`) |
| 🅿️ **estacionamento** | `estacionamento-rotativo.txt` | placa (texto fixo SigaPay Área Azul) |
| 🛣️ **pedagio** | `pedagio.txt` | placa (texto fixo CCR Via Costeira) |
| 🚦 **multa** | `multa.txt` | infrações em aberto (`cliente-despesas.json`) |
| 🤝 **renegociacao** | `renegociacao.txt` | soma das parcelas em aberto |
| 🔧 **manutencao** | `manutencao.txt` | soma das manutenções em aberto |

## Action `/relatorio-cobrancas`

Command em `.cursor/commands/relatorio-cobrancas.md`. Três parâmetros na invocação:

### Parâmetros (0 a 3 — omitir = **todos**)

| Parâmetro | Omitir significa |
|---|---|
| **tipo-despesa** | todos os tipos |
| **cliente** | todos os clientes |
| **veículo** | todos os veículos |

Pode informar **1, 2, 3 ou nenhum** parâmetro. Cliente e veículo são mutuamente exclusivos.

Exemplos:

```
/relatorio-cobrancas
/relatorio-cobrancas pagamento-semanal
/relatorio-cobrancas infracoes Daniel Damasceno
/relatorio-cobrancas pedagio RAH-4F54
/relatorio-cobrancas Daniel Damasceno
```

CLI: tipo → arg/`--tipo`; cliente → `--cliente`; veículo → `--placa`.

| Tipo | Alvos elegíveis |
|---|---|
| **pagamento-semanal** | `Locação semanal` + `ATRASADO` + em aberto (frota/cliente ativos) |
| **renegociacao** | categoria `Renegociação` em aberto |
| **infracoes** | infrações em aberto (não pagas, não quitadas DETRAN) |
| **pedagio** | categoria `Pedágio` em aberto |
| **estacionamento-rotativo** | categoria `Estacionamento` em aberto |
| **manutencao** | categoria `Manutenção` em aberto (valor > 0) |

Implementação: `src/lib/cobrancasAlvos.ts` (filtros) + `src/lib/cobrancasLote.ts` (geração).

```bash
npx tsx src/run.ts relatorio-cobrancas --listar
npx tsx src/run.ts relatorio-cobrancas pagamento-semanal --cliente "Daniel Damasceno"
npx tsx src/run.ts relatorio-cobrancas --placa RAH-4F54
```

**pagamento-semanal** gera, por alvo: tabela **semanal-atraso** (padrão obrigatório) + WhatsApp (`--dia` padrão **3**). Demais tipos: uma mensagem por placa (infrações: uma por multa).

Grava `.txt`, sidecars JSON e `dados-lote-{tipo}-{data}.json` em `relatorios/_tmp/cobrancas/`.

## Escalonamento do pagamento semanal

A partir da **data prevista** da parcela, uma mensagem por dia de atraso:

| `--dia` | Quando | Mensagem |
|---|---|---|
| **1** | 1º dia após o previsto | Lembrete de pendência |
| **2** | 2º dia | Atraso — regularizar para **evitar bloqueio** |
| **3** | 3º dia | **Bloqueio programado** por falta de compensação |
| **4** | — | Confirmação de **pagamento regularizado** (após pagar) |

## Cobrança semanal — pagamento não realizado (padrão obrigatório)

Quando o pagamento semanal **não foi realizado**, **sempre** calcular e apresentar as tabelas
dia a dia neste padrão (antes de informar valor ao locatário ou montar baixa integral).

> Implementação: `src/lib/pagamentoSemanalCobranca.ts` · CLI abaixo.

### Valores

| Campo | Fórmula |
|---|---|
| **Total/dia em dia** | `valorSemanal ÷ 7` |
| **Total/dia atrasado** | `valorDiaria` (contrato, ex. R$ 120) |
| **Juros e multa/dia** | `valorDiaria − (valorSemanal ÷ 7)` (ex. R$ 27,14) |

### Período de cada parcela em aberto

Uma **tabela por vencimento** não pago, em ordem cronológica:

| Parcela | Início | Fim |
|---|---|---|
| Com parcela seguinte | vencimento (inclusive) | véspera do próximo vencimento |
| Última em aberto | vencimento (inclusive) | vencimento + 7 dias (inclusive) |

### Situação por dia

| Situação | Quando |
|---|---|
| **Atrasado** | Dia ≥ vencimento **e** dia ≤ data do pagamento (vencimento **incluso** se não pago) |
| **Em dia** | Dia > data do pagamento (dentro do período da parcela) |

### Colunas da tabela (ordem fixa)

| Data | Dia | Situação | Juros e multa | Total/dia |

- **Juros e multa:** valor quando **Atrasado**; `—` quando **Em dia**.
- **Total/dia:** `valorDiaria` se Atrasado; `valorSemanal÷7` se Em dia.
- Subtotais: **Juros e multa** (soma) + **Total** da tabela.
- Várias parcelas: **Total geral** = soma dos totais de cada tabela.

### CLI

```bash
npx tsx src/run.ts relatorio-cobrancas semanal-atraso --cliente "Daniel Damasceno" --data-pagamento 30/06/2026
npx tsx src/run.ts relatorio-cobrancas semanal-atraso --placa RAH-4F54 --vencimento 20/06/2026 --vencimento 27/06/2026 --data-pagamento 30/06/2026 --no-salvar
```

Sem `--vencimento`, lê despesas **ATRASADO** em aberto do cliente. Valores do contrato ativo
(`contratos.json`); override com `--valor-semanal` / `--valor-diaria`.

Grava `relatorios/cobrancas/semanal-atraso-*.md` e `dados-semanal-atraso-*.json`.

**Canvas:** ao calcular cobrança semanal em atraso, criar canvas a partir do JSON (mesmo padrão
da secção Canvas abaixo).

Detalhes: `reference.md` nesta pasta.

## CLI

```bash
npx tsx src/run.ts relatorio-cobrancas semanal --placa AVU-6740 --dia 1
npx tsx src/run.ts relatorio-cobrancas estacionamento --placa AVU-6740
npx tsx src/run.ts relatorio-cobrancas pedagio --placa AVU-6740
npx tsx src/run.ts relatorio-cobrancas multa --placa QJB-0I83 [--auto P07MQ009QP]
```

Opções: `--no-salvar` (só imprime), `--out DIR` (padrão `relatorios/cobrancas/`), `--nome NOME` (saudação personalizada).

Além dos `.txt`, cada execução grava um **JSON consolidado** `dados-{tipo}-{placa}-{data}.json` no diretório de saída — é o **sidecar que alimenta o canvas**.

## Canvas (obrigatório junto ao TXT)

**Toda cobrança gera dois entregáveis: o(s) `.txt` (para WhatsApp) e um canvas.** Depois de rodar a CLI, **sempre** crie um canvas a partir do JSON consolidado (`relatorios/cobrancas/dados-*.json`).

- **Local do arquivo:** `~/.cursor/projects/d-Dropbox-Aworklanza/canvases/cobranca-{tipo}-{placa}.canvas.tsx` (kebab-case; só o IDE detecta nesse diretório).
- **Dados:** leia o JSON e **embuta inline**; importe **só** de `cursor/canvas`; sem rede/imports relativos; cores via `useHostTheme()`.
- **Conteúdo:** cabeçalho (tipo da cobrança, placa, marca/modelo, nome do condutor). Para **multa**: uma tabela com uma linha por infração (auto, data/hora, local, descrição, **valor R$**) e o total. Para **semanal/estacionamento/pedágio**: cartão com o resumo e o **texto da mensagem** (pré-visualização do que vai pro WhatsApp). Omita campos vazios.
- Sem slop (sem gradiente, emoji como ícone, sombra); rótulos claros com `R$` nos valores monetários.
- Ao terminar, mencione o canvas com link markdown para o caminho do `.canvas.tsx`.

**Saudação com nome:** os textos usam "Olá, {NOME}!". O nome (primeiro nome) é resolvido automaticamente — multa pelo `condutorId` da despesa (ou inferido pela data via contrato); semanal/estacionamento/pedágio pelo **contrato ativo hoje** da placa. Sem contrato/condutor, vira "Olá!". Use `--nome` para forçar.

- **multa / infracoes:** gera **uma mensagem por infração em aberto** da placa (categoria `Infração`, não paga, não quitada no DETRAN). Ignora lançamentos espelhados do Rastreame (`origem: rastreame` / auto `RAST-…`). Use `--auto` para uma multa específica (modo por placa).
- **renegociacao / manutencao:** valor total = soma de `valorMulta` das despesas em aberto da placa.
- **estacionamento / pedagio:** valor/pontos no texto são **fixos** (aviso do CTB), não vêm do banco — só precisam da placa.

## Ao perguntar o veículo

Sempre que questionar/listar um veículo, informar **placa + marca/modelo + ano** (de `veiculos.json`) — nunca só a placa.

## Antes de cobrar

- **multa:** rodar **sync-infracoes** antes para garantir multas atualizadas em `cliente-despesas.json`.
- Conferir marca/modelo/cor da placa em `veiculos.json` (preenche `{MARCA_MODELO}` / `{MODELO_COR}`).
- Os dados de pagamento (PIX/lotérica) são **fixos** nos templates `semanal-*`; editar lá se mudarem.

## Editar/adicionar modelos

Cada arquivo em `templates/cobrancas/` é o texto literal enviado (com formatação WhatsApp: `*negrito*`). Campos disponíveis:
`{PLACA}`, `{NOME}`, `{MARCA_MODELO}`, `{MODELO_COR}`, `{DESCRICAO}`, `{DATA}`, `{HORA}`, `{LOCAL}`, `{VALOR}`.
Para mudar o texto de uma cobrança, edite o `.txt` — não é preciso mexer no código. A saudação "Olá, {NOME}!" colapsa para "Olá!" quando não há nome.

Todas as mensagens recebem automaticamente um **rodapé em itálico** indicando envio automático pelo sistema "Gerenciador de Locações Veiculares" (constante `RODAPE_AUTOMATICO` em `src/lib/cobrancas.ts` — alterar lá).

## Skills relacionadas

- **sync-infracoes** — atualiza multas em `cliente-despesas.json`.
- **cadastro-recebimento** — pagamento semanal (Rastreame Gastos Gerais).
