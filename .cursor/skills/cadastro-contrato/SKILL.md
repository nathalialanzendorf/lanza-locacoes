---
name: cadastro-contrato
description: >-
  CRUD de contratos de locação Lanza: gerar Word/PDF, sincronizar database/contratos.json,
  efetivar encerramento (data, quebra, devolvido/recuperado) e excluir registro.
  Use when the user asks contrato, locação, gerar contrato, cadastro contrato,
  encerrar contrato (efetivar), renovação, ou database/contratos.json.
---

# Cadastro de contrato de locação

Skill **única** para contratos Lanza: **cadastrar**, **editar/sincronizar**, **encerrar** (efetivar) e **excluir** registro em `database/contratos.json`, além de **gerar** `.docx`/`.pdf`.

O **acerto financeiro** (multas, parcelas, diárias, caução) é só cálculo — skill **relatorio-encerramento-contrato**. Depois de validar o relatório, use **cadastro-contrato encerrar** aqui.

## ⚠️ Local do contrato — SEMPRE dentro da pasta do veículo

A pasta `DD.MM.AAAA - Nome` do contrato **deve ficar dentro da pasta do veículo locado**
(ex.: `D:\Dropbox\Aluguel Carros\Felipe - FORD FOCUS 2013-2014\27.06.2026 - Juliano Foizer Silveira`),
**nunca na raiz** `Aluguel Carros`.

- O gerador resolve o destino por: `--contratos-dir` explícito → **`pastaVeiculo`** do veículo
  (em `database/veiculos.json`) → raiz padrão. Ou seja, ele só acerta a pasta sozinho se o
  veículo tiver o campo `pastaVeiculo` preenchido.
- **Antes de gerar, confirme** que o veículo tem `pastaVeiculo` em `veiculos.json`.
  - **Se faltar:** preencha com o nome da pasta do veículo (ex.: `"Felipe - FORD FOCUS 2013-2014"`,
    relativo à raiz; também aceita caminho absoluto) **ou** passe `--contratos-dir "…\Pasta do veículo"`.
  - Nunca gere na raiz: se cair na raiz, **mova** a pasta para dentro do veículo e **re-sincronize**
    (`cadastro-contrato sincronizar <novo caminho>`), depois **exclua o registro antigo** pelo `--id`
    (a chave de idempotência é `pastaContrato`, então mudar a pasta cria registro novo).
- **Depois de gerar, confira** que o caminho impresso (`Pasta -> …`) está dentro da pasta do veículo.

## Operações

| Operação | CLI | Efeito |
|----------|-----|--------|
| **Cadastrar / gerar** | `cadastro-contrato gerar …` | Cria pasta Word/PDF + registro em `contratos.json` |
| **Editar / sincronizar** | `cadastro-contrato sincronizar <pasta>` | Re-lê `Contrato*.docx` e atualiza `contratos.json` |
| **Encerrar (efetivar)** | `cadastro-contrato encerrar <pasta> --data … --motivo …` | Grava `dataEncerramento`, `motivoEncerramento`, `quebraContrato`, `status=encerrado` |
| **Excluir** | `cadastro-contrato excluir <pasta\|--id uuid>` | Remove registro (não apaga pasta Word) |

### Campos de encerramento (`contratos.json`)

| Campo | Valores |
|-------|---------|
| `dataEncerramento` | `DD/MM/AAAA` |
| `motivoEncerramento` | `devolvido` \| `recuperado` \| `troca` |
| `quebraContrato` | `true` se encerramento antes do fim previsto (retenção caução). **`troca` nunca é quebra** |
| `versao` | 1, 2, 3… por par cliente + veículo (renovações) |

> **Motivo `troca`:** o cliente trocou de veículo — **sempre** há um **novo contrato** para o
> mesmo cliente com **outro veículo**. Não é quebra (a caução **transfere** para o novo
> contrato), então `quebraContrato = false` por padrão (sem retenção).

## Status do cliente segue o contrato (local + Rastreame)

O status do **cliente/motorista** acompanha o ciclo de vida do contrato e é refletido
**no `database/clientes.json` E no Rastreame** (exceção autorizada à regra "Inativação só
local" — ver `.cursor/rules/lanza-tools.mdc`):

- **Ao `gerar`:** se o cliente já existe e está **inativo**, é **reativado** localmente e no
  Rastreame (PUT `ativo:true`). Cliente já ativo → no-op.
- **Ao `encerrar`:** o cliente é **inativado** localmente e no Rastreame (PUT `ativo:false`),
  **exceto** se ainda tiver **outro contrato ativo** (ex.: locatário com 2 veículos) — nesse
  caso permanece ativo.
- O lado Rastreame é **best-effort**: falha de rede/token apenas gera `[aviso]`; a mudança
  local (fonte da verdade) é sempre aplicada. Cliente sem `rastreameMotoristaKey` só muda local.
- Implementação: `src/lib/contratoClienteStatus.ts`.

## Fluxo do agente (gerar)

1. **Identificar** placa e cliente (nome ou CPF).
2. **Buscar** em `database/veiculos.json` e `database/clientes.json`.
3. **Se não existir:** skills **cadastro-veiculo** / **cadastro-cliente**.
4. **Conferir `pastaVeiculo`** do veículo em `veiculos.json` (ver ⚠️ acima) —
   preencher se faltar, ou usar `--contratos-dir`.
5. **Perguntar** período, valor semanal, caução, início, dia de pagamento.
6. **Executar:**

```bash
npx tsx src/run.ts cadastro-contrato gerar --placa PLACA --cpf CPF --semana VALOR --caucao VALOR [opções]
```

7. Confirmar que a pasta `DD.MM.AAAA - Nome/` (com `.docx`, `.pdf`, `CNH.pdf`) foi criada
   **dentro da pasta do veículo**, não na raiz.

## Fluxo encerramento (duas etapas)

1. **Relatório (só cálculo):** skill **relatorio-encerramento-contrato**
2. **Efetivar no database:**

```bash
npx tsx src/run.ts cadastro-contrato encerrar "D:/Dropbox/Aluguel Carros/.../05.05.2026 - Nome" \
  --data 26/06/2026 --motivo devolvido --quebra
```

`--motivo`: `devolvido` (devolução pelo locatário), `recuperado` (recolhimento) ou
`troca` (troca de veículo → novo contrato com outro veículo; **não é quebra** por padrão).  
`--sem-quebra` se encerrar no fim natural do prazo sem retenção (já é o padrão para `troca`).

## Sincronizar pasta existente

```bash
npx tsx src/run.ts cadastro-contrato sincronizar "D:/Dropbox/Aluguel Carros/.../05.05.2026 - Nome"
```

## Importar todos os contratos em lote

Varre a raiz (`contratosDir` de `config/lanza_paths.json`, padrão `D:\Dropbox\Aluguel Carros`),
encontra pastas `DD.MM.AAAA - Nome` com `Contrato*.docx` e registra/atualiza
`contratos.json` (idempotente por pasta; ignora `Modelo/Copy/Orçamentos`):

```bash
npx tsx src/run.ts importar-contratos --dry-run   # pré-visualiza
npx tsx src/run.ts importar-contratos             # grava
```

- **Encerramento inferido pelo nome da pasta:** sufixos como `(devolvido 26.06)`,
  `(recuperado 08.12)`, `(troca 29.05.26)`, `(Encerrado)` viram
  `status=encerrado` + `dataEncerramento` + `motivoEncerramento` + `quebraContrato`.
- **Reconciliação:** ao final, re-aplica o encerramento pelos nomes **já gravados**
  em `contratos.json` — cobre pastas arquivadas/online-only que não foram re-varridas.
- **Limitações:** pastas sem valor de locação legível no Word ficam de fora (erro
  listado); pastas **sem sufixo de status** ficam `ativo` (pode haver >1 ativo por
  placa — revisar manualmente, ou encerrar com `cadastro-contrato encerrar`).

## CLI gerar — flags

| Flag | Obrigatório | Descrição |
|------|-------------|-----------|
| `--placa` | sim | Placa em `veiculos.json` |
| `--cpf` ou `--cliente` | sim | Locatário em `clientes.json` |
| `--semana` | sim | Valor semanal (R$) |
| `--caucao` | sim | Caução (R$) |
| `--periodo` | não | `3 meses` (padrão), `6 meses`, `1 ano`, etc. |
| `--dia-pagamento` | não | ex. `todos os sábados` |
| `--cnh-arquivo` | não | Copia como `CNH.pdf` |
| `--contratos-dir` | não | Pasta do veículo (sobrepõe `pastaVeiculo`). Padrão: `pastaVeiculo` → raiz |

Modo JSON legado:

```bash
npx tsx src/run.ts cadastro-contrato gerar "relatorios/_dados_contrato_tmp.json"
```

## Aliases legados (run.ts)

- `cadastro-contrato` → `cadastro-contrato gerar`
- `registrar-contrato` → `cadastro-contrato sincronizar`
- `registrar-encerramento-contrato` → `cadastro-contrato encerrar` (motivo `devolvido` + quebra)

## Idempotência

- **`sincronizar`:** chave `pastaContrato` — reexecutar **atualiza** `contratos.json`, não duplica.
- **`gerar`:** cria ficheiros Word/PDF; repetir pode sobrescrever na mesma pasta (confirmar com operador).
- Ver [`_idempotencia.md`](../_idempotencia.md).

## Skills relacionadas

- **cadastro-cliente**, **cadastro-veiculo** — onboarding antes de gerar.
- **relatorio-encerramento-contrato** — acerto financeiro antes de efetivar encerramento.
- **cadastro-recebimento** — parcelas pagas (input do relatório).

## Privacidade

CNH, CPF e endereço são dados sensíveis. Não commitar em repositório público.
