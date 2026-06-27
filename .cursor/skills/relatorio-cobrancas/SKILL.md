---
name: relatorio-cobrancas
description: >-
  Gera mensagens de cobrança prontas para WhatsApp (com ícones e formatação) a
  partir de templates em templates/cobrancas/ e dados de database/cliente-despesas.json
  e database/veiculos.json. Cobre multa (infração de trânsito), pedágio, estacionamento
  rotativo e pagamento semanal (escalonamento dia 1 lembrete, dia 2 atraso/bloqueio,
  dia 3 bloqueio programado, dia 4 regularizado). Use para cobrança WhatsApp, cobrar
  multa/pedágio/rotativo, lembrete/atraso/bloqueio de pagamento semanal.
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

## Escalonamento do pagamento semanal

A partir da **data prevista** da parcela, uma mensagem por dia de atraso:

| `--dia` | Quando | Mensagem |
|---|---|---|
| **1** | 1º dia após o previsto | Lembrete de pendência |
| **2** | 2º dia | Atraso — regularizar para **evitar bloqueio** |
| **3** | 3º dia | **Bloqueio programado** por falta de compensação |
| **4** | — | Confirmação de **pagamento regularizado** (após pagar) |

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

- **multa:** gera **uma mensagem por infração em aberto** da placa (categoria `Infração`, não paga, não quitada no DETRAN). Ignora lançamentos espelhados do Rastreame (`origem: rastreame` / auto `RAST-…`). Use `--auto` para uma multa específica.
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
