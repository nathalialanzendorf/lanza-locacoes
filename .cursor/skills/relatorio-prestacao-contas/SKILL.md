---
name: relatorio-prestacao-contas
description: >-
  Builds the monthly partner/vehicle accountability report from
  database/parceiro-despesas.json, with fixed tracker charge and insurance validation.
  Use when the user asks for prestação de contas, relatório mensal parceiro,
  or arquivo em prestação de contas.
---

# Relatório de Prestação de Contas Mensal

Gera o **relatório mensal** por veículo e consolidado por parceiro. Gastos em `database/parceiro-despesas.json`; ganho, devido do mês anterior e desconto de manutenção vêm das perguntas. Formato alinhado a `templates/prestacao-contas/Prestação contas parceiro.txt`.

**Idempotência:** skill só leitura (gera `.txt`); dados idempotentes vêm de **sync-seguro**, **cadastro-despesa** (`gravar-rastreador`), etc. — ver [`_idempotencia.md`](../_idempotencia.md).

## Regras fixas

1. **Sempre perguntar o escopo:** um **parceiro**, uma **placa** ou a **frota toda**. Por defeito **excluir da prestação** a frota própria do **Felipe** (veículos que lhe estão vinculados em `parceiro-veiculo.json`), salvo se o utilizador pedir para incluir.
2. **Pré-requisito:** seguro do mês importado (**sync-seguro** a partir dos PDFs em `seguroComprovantesDir`), exceto parceiros sem seguro: **Luiz Paulo, Jhonny, Baiano** (não exigir boleto nem avisar falta para eles).
3. **Rastreador fixo:** **R$ 50,00** no **dia 10** da competência. Correr **`gravar-rastreador`** (skill **cadastro-despesa**) antes do relatório; o `montar-relatorio` só completa se faltar entrada no veículo/mês.
4. **Defaults de ganho:** semanal **R$ 500** e diária **R$ 71,42** (500÷7); sugerir **4 semanas = R$ 2.000**.
5. **William / PWH-3A45 (Doblo):** ganho mensal fixo **R$ 1.100** (não perguntar semanas).
6. Veículos do **Felipe** (frota própria) **não entram** na prestação para parceiros, salvo instrução em contrário.
7. **Todos os veículos entram** no relatório de despesas — **tanto os de locação quanto os particulares** (`"particular": true` em `veiculos.json`, ex.: Nivus RYC-7C32, Baja Bugg ICZ-2H47). Diferença para o particular: **não** recebe o **rastreador fixo** automático (não é veículo de locação) e o **ganho** normalmente é **R$ 0** (não está locado); o relatório lista apenas os gastos do veículo.
8. **IPVA / Licenciamento (DETRAN):** ver secção própria abaixo — sempre **perguntar ao utilizador com seletor** antes de incluir.
9. **Despesas vencidas viram lembrete:** IPVA/Licenciamento **já vencidos** (vencimento antes do início do período) e **ainda sem baixa** reaparecem automaticamente numa secção **"⚠️ Pendências vencidas (lembrete)"** por veículo — **apenas informativo, NÃO somado** ao total do mês (o saldo real continua via *Devido mês anterior*). Some quando o débito recebe **baixa**. Ver secção **Baixa / pendências vencidas**.

## IPVA e Licenciamento

O sync DETRAN (**sync-ipva-licenciamento**) grava em `parceiro-despesas.json` **todas as formas do mesmo IPVA**: a **cota única** *e* as **3 parcelas** (1ª/2ª/3ª), por vencimento. **São alternativas do mesmo imposto** — nunca somar cota única + parcelas (duplicaria o valor).

Antes de incluir IPVA/Licenciamento no relatório, **sempre usar seletor**, por veículo que tenha esses débitos na competência:

### IPVA

1. **Quem paga?**
   - **Parceiro paga por conta própria** → **não entra** na prestação (não cobrar).
   - **Locadora paga e cobra do parceiro** → entra na prestação.
2. **Se a locadora paga, qual forma?** (só para IPVA, que tem parcelamento)
   - **Cota única — R$ X** (valor cheio), ou
   - **3 parcelas — R$ Y cada** (incluir as parcelas conforme vencimento).
   - Incluir **apenas a opção escolhida**; **nunca somar** as duas.

### Licenciamento

Mesma pergunta de **quem paga** (parceiro por conta própria → não entra; locadora paga e cobra → entra). **Não** perguntar cota única vs parcelas — o licenciamento é **valor único, sem parcelamento**.

Montar o `entrada.json` já com as opções escolhidas (no IPVA: cota única **ou** parcelas, nunca ambas). As linhas não escolhidas ficam no database, mas **não entram** no relatório do mês.

## Baixa / pendências vencidas

Para um débito **vencido** (IPVA/Licenciamento) parar de aparecer como lembrete, dar **baixa** quando for pago/resolvido. Há **duas formas** (ambas escrevem o campo `baixa` em `parceiro-despesas.json`):

1. **Manual** (skill **cadastro-despesa**):

```bash
npx tsx src/run.ts gravar-despesa baixa "MLN-0B87" "IPVA" "07/2026"          # quita (data = hoje)
npx tsx src/run.ts gravar-despesa baixa "MLN-0B87" "IPVA" "07/2026" "15/12/2026"  # data específica
npx tsx src/run.ts gravar-despesa baixa --id <id> --desfazer                  # reabre
```

2. **Automática pelo Rastreame:** ao rodar **`sync-manutencao`**, despesas cujo espelho na tela Manutenção estiver com status **Pago/Quitado** recebem baixa local (contador `baixados` na saída).

Regras do lembrete (`montar-relatorio`):

- Só **IPVA** e **Licenciamento**; só os de **competência anterior** ao período (vencidos), **sem baixa**.
- **IPVA** dedupe por ano: se houver **cota única**, as **parcelas** do mesmo ano são omitidas (mesma dívida) — lista e total ficam coerentes.
- O bloco é **lembrete**: não entra no total nem no consolidado.

## Competência e período

- Perguntar **competência** `MM/AAAA`.
- Confirmar **período** exibido no cabeçalho (início/fim; padrão: 1º e último dia do mês).

## Locação no período

Para cada veículo, confirmar se ficou locado o mês todo, devolução em data X, ou parado. **Sugestão:** inferir de pastas `DD.MM.AAAA - cliente` em `contratosDir` (`config/lanza_paths.json`, padrão `D:\Dropbox\Aluguel Carros`) e cláusula 1.2 dos contratos; validar com o usuário.

## Validação

- Conferir **Seguro** na competência (avisar se faltar, exceto parceiros da lista sem seguro).
- Perguntar se há mais despesas antes de fechar (**cadastro-despesa**).

## Entrada (`montar-relatorio`)

Montar `entrada.json` e rodar:

```bash
npx tsx src/run.ts montar-relatorio "relatorios/_entrada_tmp.json"
```

Exemplo:

```json
{
  "competencia": "06/2026",
  "rotulo": "Relatório de junho/2026",
  "periodo": {"inicio": "01/06/2026", "fim": "30/06/2026"},
  "rastreadorDia": 10,
  "veiculos": [
    {"placa":"MLN-0B87",
     "ganho":{"valor":2000.0,"descricao":"4 semanas"},
     "devidoMesAnterior":0,
     "descontoManutencao":{"valor":0,"descricao":""}}
  ]
}
```

Saída: `Financeiro/prestação de contas/MM.AAAA/<Parceiro>.txt` por defeito (ver `financeiro` + `prestacaoContasSubpasta` em `config/lanza_paths.json`; se o JSON não existir, cai no legado `prestação de contas/` na raiz do repo).

Além dos `.txt` por parceiro, cada execução grava um **JSON consolidado** em `relatorios/_tmp/prestacao-MM-AAAA.json` (no repo, fora da pasta partilhada) com todos os parceiros, veículos, gastos, totais e pendências — é o **sidecar que alimenta o canvas**.

## Canvas (obrigatório junto ao TXT)

**Toda prestação de contas gera dois entregáveis: o(s) `.txt` (para WhatsApp) e um canvas.** Depois de rodar `montar-relatorio`, **sempre** crie um canvas a partir do JSON consolidado (`relatorios/_tmp/prestacao-MM-AAAA.json`).

- **Local do arquivo:** `~/.cursor/projects/d-Dropbox-Aworklanza/canvases/prestacao-{parceiro}-{MM-AAAA}.canvas.tsx` (um canvas por parceiro, ou um com seletor; kebab-case; só o IDE detecta nesse diretório).
- **Dados:** leia o JSON e **embuta inline**; importe **só** de `cursor/canvas`; sem rede/imports relativos; cores via `useHostTheme()`.
- **Conteúdo:** cabeçalho (parceiro, competência, período). Por veículo: tabela de **gastos** (data, descrição, **valor R$**) com subtotal; linha de **ganho**, **desconto mês anterior**, **desconto manutenção** e **TOTAL** em destaque. Bloco **CONSOLIDADO** do parceiro (total descontos, total ganhos, **total líquido**). Se houver, secção **⚠️ Pendências vencidas (lembrete)** — claramente marcada como **não somada** ao total. Omita seções vazias.
- Sem slop (sem gradiente, emoji como ícone, sombra); rótulos claros com `R$`; o líquido é o número de destaque.
- Ao terminar, mencione o canvas com link markdown para o caminho do `.canvas.tsx`.

## Skills relacionadas

- **sync-seguro**, **cadastro-despesa**
