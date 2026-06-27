---
name: cadastro-despesa
description: >-
  CRUD partner vehicle debits in database/parceiro-despesas.json (IPVA, insurance,
  maintenance, etc.). Use when registering, editing, or removing expenses in
  parceiro-despesas.json.
---

# Cadastro de despesa (parceiro)

Cadastra, edita e exclui **débitos do parceiro/dono** em `database/parceiro-despesas.json`.

## ⚠️ Regra: gravar no database **e** enviar ao Rastreame (obrigatório)

**Sempre** que o operador pedir um cadastro de despesa, o fluxo é **duas etapas, ambas obrigatórias**:

1. **Salvar** no `database/` (aqui: `parceiro-despesas.json`).
2. **Enviar ao Rastreame** (push) — despesa de parceiro vai para a tela **Manutenção** via
   `sync-manutencao`.

```bash
npx tsx src/run.ts sync-manutencao --placa PLACA   # (ou --categoria CAT)
```

Não deixar a despesa **só local**. Se faltar token do Rastreame, **pedir as credenciais**
(ver tool `.cursor/tools/rastreame/`) e concluir o push — não considerar o cadastro completo
enquanto não espelhar no Rastreame.

## Formato ao listar despesas de parceiros (obrigatório)

**Sempre** que o operador pedir **despesas dos parceiros / débitos do dono**, retornar uma
tabela com **exatamente estas colunas, nesta ordem** (iguais ao cadastro de **Manutenção**
do Rastreame):

| Rastreável | Data | Descrição | Tipo | Total | Status |
|---|---|---|---|---|---|

- **Rastreável:** rótulo do veículo (`rastreameLabel` de `veiculos.json`).
- **Data:** `DD/MM/AAAA`.
- **Descrição:** texto da despesa.
- **Tipo:** categoria (`Manutenção`, `Seguro`, `Rastreador`, `IPVA`, `Licenciamento`, `Outros`).
- **Total:** valor em `R$`.
- **Status:** situação de pagamento (ex.: `Pago` / `Pendente`).

Fechar com a linha de **Total** somando as despesas.

## Operações

| Operação | Como |
|----------|------|
| **Cadastrar** | `gravar-despesa` (idempotente) ou sync DETRAN / sync-seguro |
| **Rastreador (lote)** | `gravar-rastreador` — taxa fixa mensal por veículo (ver abaixo) |
| **Editar** | Repetir `gravar-despesa` com **mesma** placa + competência + categoria + descrição (atualiza) |
| **Baixa** | `gravar-despesa baixa <placa> <categoria> [competencia] [data]` — quita o débito (`--desfazer` reabre) |
| **Excluir** | Remover entrada do JSON (confirmar com operador) |

## Sempre perguntar (nesta ordem)

1. **Tipo** — `Manutenção`, `Seguro`, `Rastreador`, `IPVA`, `Licenciamento` ou `Outros`.
2. **Valor** — R$ (ex.: `50,00`).
3. **Data** — DD/MM/AAAA.
4. **Veículo** — placa de `database/veiculos.json`.

Para `Outros`, pedir **descrição** curta. Nos demais, usar o nome do tipo salvo indicação contrária.

## Workflow

1. Coletar dados (listar placas de `veiculos.json`). Se a placa não existir, avisar e oferecer **cadastro-veiculo**; ainda assim é possível gravar com `veiculoId = null`.
2. Confirmar resumo antes de gravar.
3. Executar:

```bash
npx tsx src/run.ts gravar-despesa "Manutenção" "50,00" "10/06/2026" "MLX-2H34" "Conserto buzina"
```

Argumentos: `<categoria> <valor> <data> <placa> [descricao]`

## Rastreador fixo mensal (lote)

O **rastreador** é uma despesa fixa de parceiro — **não** é um sync (não busca nada externo nem replica no Rastreame), apenas grava localmente em `database/parceiro-despesas.json` para **cada veículo** de `database/veiculos.json`, **por competência (mês)**.

| Campo | Valor |
|-------|-------|
| `categoria` | `Rastreador` |
| `descricao` | `Rastreador` |
| `valor` | **R$ 50,00** (todos os meses) |
| `data` | **dia 10** do mês da competência (`10/MM/AAAA`) |
| `competencia` | `MM/AAAA` |
| `origem` | `rastreador-fixo/{PLACA}/{MM-AAAA}` (única por veículo/mês) |

```bash
npx tsx src/run.ts gravar-rastreador
npx tsx src/run.ts gravar-rastreador --desde 01/2026 --ate 06/2026
npx tsx src/run.ts gravar-rastreador --dry-run
```

> Por defeito: `--desde 01/2026` até o **mês corrente**. Alias legado: `sync-rastreador`.
> Código: `src/lib/rastreadorFixo.ts`, `src/cli/gravarRastreador.ts`.

Fluxo: correr `gravar-rastreador` (ou `--dry-run` para pré-visualizar) → confirmar resumo `N veículos × M meses` (novos/atualizados/sem alteração). Veículos novos em `veiculos.json` entram automaticamente na próxima execução.

## Baixa de débito (lembrete de vencidos)

Despesas **vencidas** de **IPVA/Licenciamento** sem baixa reaparecem como **lembrete** no relatório de prestação de contas (não somam ao total). Para encerrar o lembrete, dar **baixa** quando o débito for pago/resolvido — grava o campo `baixa` (DD/MM/AAAA) em `parceiro-despesas.json`:

```bash
npx tsx src/run.ts gravar-despesa baixa "MLN-0B87" "IPVA" "07/2026"           # quita com a data de hoje
npx tsx src/run.ts gravar-despesa baixa "MLN-0B87" "Licenciamento" "09/2026" "15/12/2026"
npx tsx src/run.ts gravar-despesa baixa --id <id> --desfazer                  # reabre (baixa = null)
```

- Sem `competencia`, baixa **todas** as despesas da placa+categoria — use a competência para mirar uma só.
- **Alternativa automática:** `sync-manutencao` dá baixa nas despesas marcadas como **Pago** na tela Manutenção do Rastreame.

## Espelhar no Rastreame (tela Manutenção)

Toda despesa de parceiro (rastreador, seguro, IPVA, licenciamento, manutenção, etc.) é espelhada na tela **Manutenção** do Rastreame (tipo `OUTROS`), via push idempotente:

```bash
npx tsx src/run.ts sync-manutencao --dry-run            # pré-visualizar tudo
npx tsx src/run.ts sync-manutencao --placa AVU-6740     # uma placa
npx tsx src/run.ts sync-manutencao --categoria Rastreador
```

Guarda `rastreameManutencaoId` em `parceiro-despesas.json` (com id → PUT/skip; sem id → dedupe por rastreável+info+data e POST). O rastreável vem de `rastreameRastreavelKey` em `veiculos.json`. Ver tool **`.cursor/tools/rastreame/`**.

## Idempotência

- **Chave manual (`gravar-despesa`):** `placa + competencia + categoria + descricao`.
- **Chave rastreador (`gravar-rastreador`):** `placa + competencia + Rastreador` · `origem: rastreador-fixo/...`. Reexecutar **atualiza** valor/data se divergirem e **remove duplicatas** antigas; **não duplica**.
- **Espelho Rastreame (`sync-manutencao`):** `rastreameManutencaoId` por registo; sem id, dedupe por `rastreável + info + data` antes do POST.
- Repetir o mesmo comando **atualiza** o registo existente (`sem_alteracao` se nada mudou).
- Syncs automáticos (seguro, DETRAN) têm chaves próprias — ver [`_idempotencia.md`](../_idempotencia.md).

## Critério de conclusão

- Registro em `database/parceiro-despesas.json` com `id` (UUID da **despesa**) e `veiculoId` = **uuid** do veículo em `veiculos.json` (ou `null` com aviso).

## Skills relacionadas

- **sync-ipva-licenciamento** — IPVA e Licenciamento em lote; skill **sync-ipva-licenciamento** (tool DETRAN).
- **sync-seguro** — seguro em lote (valor variável por veículo; **não** confundir com rastreador fixo).
- **relatorio-prestacao-contas** — consome `parceiro-despesas.json` (rastreador fixo, fallback R$ 50 se faltar).
- **cadastro-veiculo** — nova placa passa a receber lançamentos de rastreador no próximo `gravar-rastreador`.
