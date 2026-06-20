---
name: cadastrar-despesa
description: >-
  Registers a vehicle expense in database/despesas.json. Always collects type
  (maintenance, insurance, tracker, other), amount, date, and vehicle plate.
  Use when the user asks to register an expense, gasto, despesa, seguro,
  manutenção, or update despesas.json.
---

# Cadastrar Despesa

Cadastra uma **despesa/gasto** de veículo em `database/despesas.json`. Os gastos alimentam o skill **relatorio-prestacao-contas**.

## Sempre perguntar (nesta ordem)

1. **Tipo** — `Manutenção`, `Seguro`, `Rastreador` ou `Outros`.
2. **Valor** — R$ (ex.: `50,00`).
3. **Data** — DD/MM/AAAA.
4. **Veículo** — placa de `database/veiculos.json`.

Para `Outros`, pedir **descrição** curta. Nos demais, usar o nome do tipo salvo indicação contrária.

## Workflow

1. Coletar dados (listar placas de `veiculos.json`). Se a placa não existir, avisar e oferecer **cadastrar-veiculo**; ainda assim é possível gravar com `veiculoId = null`.
2. Confirmar resumo antes de gravar.
3. Executar:

```bash
python ".cursor/skills/cadastrar-despesa/scripts/gravar_despesa.py" "Manutenção" "50,00" "10/06/2026" "MLX-2H34" "Conserto buzina"
```

Argumentos: `<categoria> <valor> <data> <placa> [descricao]`

## Critério de conclusão

- Registro em `database/despesas.json` com `id` (UUID da **despesa**) e `veiculoId` = **uuid** do veículo em `veiculos.json` (ou `null` com aviso).

## Skills relacionadas

- **importar-boletos-seguro** — seguro em lote.
- **relatorio-prestacao-contas** — consome despesas.
- **cadastrar-veiculo** — nova placa.
