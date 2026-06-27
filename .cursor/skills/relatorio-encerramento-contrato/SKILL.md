---
name: relatorio-encerramento-contrato
description: >-
  Calculates vehicle rental contract closure report only (no database writes):
  unpaid fines, overdue rent, daily late fees, deposit retention, final balance.
  Use for encerramento de contrato, acerto final, retenção caução, multas do locatário.
  To record closure use cadastro-contrato encerrar.
---

# Relatório de encerramento de contrato

Calcula o **acerto** de um contrato: multas, parcelas em aberto, diárias de atraso, retenção de caução e saldo final.

**Só o contrato vigente:** último `Contrato*.docx` na pasta (maior `vN`) e, se existir em `contratos.json`, a maior `versao` do par locatário+veículo. Renovações anteriores não entram no cálculo.

**Não grava** em `database/contratos.json`. Para efetivar encerramento → skill **cadastro-contrato** (`encerrar`).

**Idempotência:** skill só leitura — reexecutar gera o mesmo relatório; não altera bases.

> **Veículos particulares** (`"particular": true` em `veiculos.json`) não têm contrato de locação — `calcularEncerramentoContrato` recusa essas placas.

## Quando usar

- Simular ou apresentar acerto antes de devolver caução.
- Conferir multas cobráveis no período da locação.
- Validar semanas pagas e débitos pendentes.

## Perguntas (ordem)

1. **Pasta do contrato** — `DD.MM.AAAA - Nome` em `contratosDir`.
2. **Data de encerramento** — `DD/MM/AAAA`.
3. **Semanas já pagas** — lista `DD/MM/AAAA` (cruzar com **cadastro-recebimento** / Rastreame).
4. **Multas já pagas** — autos a excluir.
5. **Confirmar condutores** — `condutorConfirmado: false` exige revisão.

## Executar (CLI)

```bash
npx tsx src/run.ts relatorio-encerramento-contrato "D:/Dropbox/Aluguel Carros/.../05.05.2026 - Nome" --encerramento 26/06/2026
```

Grava automaticamente em **`relatorios/quebra-contrato/`**:

- `quebra-contrato-{placa}-{cliente}-{DD-MM-AAAA}.txt` — documento para partilhar com o locatário (como prestação de contas com parceiros)
- `quebra-contrato-{placa}-{cliente}-{DD-MM-AAAA}.json` — **dados estruturados (sidecar) que alimentam o canvas** (mesma base do `.txt`)

Com JSON de **entrada** (semanas pagas, etc.) — o JSON é só parâmetro, não é gerado como saída:

```bash
npx tsx src/run.ts relatorio-encerramento-contrato relatorios/_tmp/_encerramento_tmp.json
```

`--out` sobrescreve o `.txt`; o **JSON é gravado por padrão** ao lado do `.txt` (`--out-json` muda o caminho); `--no-salvar` só imprime no terminal (não grava `.txt` nem `.json`).

## Canvas (obrigatório junto ao TXT)

**Todo relatório de encerramento gera dois entregáveis: o `.txt` (para WhatsApp) e um canvas.** Depois de rodar a CLI, **sempre** crie um canvas a partir do JSON sidecar (`relatorios/quebra-contrato/quebra-contrato-*.json`).

- **Local do arquivo:** `~/.cursor/projects/d-Dropbox-Aworklanza/canvases/encerramento-{placa}-{cliente}.canvas.tsx` (kebab-case; só o IDE detecta nesse diretório).
- **Dados:** leia o JSON sidecar e **embuta os valores inline** no `.canvas.tsx` — sem `fetch`/rede, sem imports relativos; importe **só** de `cursor/canvas`; cores via `useHostTheme()`.
- **Conteúdo mínimo:** cabeçalho (cliente, placa, início → fim, encerramento, dias de locação); cartão de destaque com o **Saldo caução** (verde a devolver / vermelho a complementar); tabelas de **infrações**, **manutenção**, **parcelas em aberto** e **diárias de atraso** (cada uma com seu subtotal); bloco de **retenção de caução** (dias restantes, %, retenção, a devolver); e os **avisos** se houver. Omita seções vazias (ex.: sem infrações, não renderize a tabela).
- Sem slop (sem gradiente, emoji, sombra); rótulos claros com `R$` nos valores.
- Ao terminar, mencione o canvas com link markdown para o caminho do `.canvas.tsx`.

Exemplo `entrada.json`:

```json
{
  "pastaContrato": "D:/Dropbox/Aluguel Carros/.../05.05.2026 - Nome",
  "dataEncerramento": "26/06/2026",
  "semanasPagas": ["12/05/2026"],
  "infracoesPagasAuto": [],
  "incluirTodasInfracoesPlaca": false
}
```

## Após o relatório

1. Validar multas e semanas com o operador.
2. **Efetivar encerramento:** `cadastro-contrato encerrar` com `--data`, `--motivo devolvido|recuperado`, `--quebra` se aplicável.
3. Marcar multas quitadas em `cliente-despesas.json`; lançamentos Rastreame via **cadastro-recebimento**.

## Fórmulas

| Item | Cálculo |
|------|---------|
| **Diária** | valor semanal ÷ 7 |
| **Multas** | `cliente-despesas.json`, categoria Infração, não pagas, no período |
| **Parcelas em aberto** | Vencimentos semanais não listados em `semanasPagas` |
| **Retenção caução** | caução × (diasRestantes ÷ prazoDias) |
| **Saldo** | caução − total débitos |

> **Infrações fora do cálculo:** as **quitadas no DETRAN** (`quitadaDetran: true`) e as **sem data de autuação** (não há como comparar com a vigência) **não entram** na cobrança do locatário — só multas **com data**, **não quitadas** e **não pagas**, no período. (Ver regra em **sync-infracoes**.)

Detalhes: `reference.md` nesta pasta.

## Skills relacionadas

- **cadastro-contrato** — gerar contrato e **efetivar** encerramento no database.
- **cadastro-recebimento** — parcelas pagas.
- **sync-infracoes** — multas em `cliente-despesas.json` (skill + tool DETRAN).

## Alias legado

`encerrar-contrato` → `relatorio-encerramento-contrato` (só cálculo; grava em `relatorios/`).
