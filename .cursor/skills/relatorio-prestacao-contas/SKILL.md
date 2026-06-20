---
name: relatorio-prestacao-contas
description: >-
  Builds the monthly partner/vehicle accountability report from
  database/despesas.json, with fixed tracker charge and insurance validation.
  Use when the user asks for prestação de contas, relatório mensal parceiro,
  or arquivo em prestação de contas.
---

# Relatório de Prestação de Contas Mensal

Gera o **relatório mensal** por veículo e consolidado por parceiro. Gastos em `database/despesas.json`; ganho, devido do mês anterior e desconto de manutenção vêm das perguntas. Formato alinhado a `templates/Prestação contas parceiro.txt`.

## Regras fixas

1. **Sempre perguntar o escopo:** um **parceiro**, uma **placa** ou a **frota toda** (apenas veículos de parceiros `tipo=parceiro`; excluir `tipo=empresa` / Lanza frota própria conforme regra do negócio).
2. **Pré-requisito:** seguro do mês importado (**importar-boletos-seguro**), exceto parceiros sem seguro: **Luiz Paulo, Jhonny, Baiano** (não exigir boleto nem avisar falta para eles).
3. **Rastreador fixo:** R$ **50,00** no **dia 10** do mês da competência, se ainda não houver rastreador naquele veículo/mês em `despesas.json`.
4. **Defaults de ganho:** semanal **R$ 500** e diária **R$ 71,42** (500÷7); sugerir **4 semanas = R$ 2.000**.
5. **William / PWH-3A45 (Doblo):** ganho mensal fixo **R$ 1.100** (não perguntar semanas).
6. Veículos **Lanza Locações** (`tipo=empresa`) **não entram** na prestação.

## Competência e período

- Perguntar **competência** `MM/AAAA`.
- Confirmar **período** exibido no cabeçalho (início/fim; padrão: 1º e último dia do mês).

## Locação no período

Para cada veículo, confirmar se ficou locado o mês todo, devolução em data X, ou parado. **Sugestão:** inferir de pastas `contratos/DD.MM.AAAA - cliente` e cláusula 1.2 dos contratos; validar com o usuário.

## Validação

- Conferir **Seguro** na competência (avisar se faltar, exceto parceiros da lista sem seguro).
- Perguntar se há mais despesas antes de fechar (**cadastrar-despesa**).

## Entrada do script

Montar `entrada.json` e rodar:

```bash
python ".cursor/skills/relatorio-prestacao-contas/scripts/montar_relatorio.py" "relatorios/_entrada_tmp.json"
```

Exemplo:

```json
{
  "competencia": "06/2026",
  "rotulo": "Relatório de junho/2026",
  "periodo": {"inicio": "01/06/2026", "fim": "30/06/2026"},
  "rastreadorValor": 50.0,
  "rastreadorDia": 10,
  "veiculos": [
    {"placa":"MLN-0B87",
     "ganho":{"valor":2000.0,"descricao":"4 semanas"},
     "devidoMesAnterior":0,
     "descontoManutencao":{"valor":0,"descricao":""}}
  ]
}
```

Saída: `prestação de contas/MM.AAAA/<Parceiro>.txt` (na raiz do repositório).

## Skills relacionadas

- **importar-boletos-seguro**, **cadastrar-despesa**
