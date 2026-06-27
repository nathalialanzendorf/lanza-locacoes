---
name: sync-seguro
description: >-
  Reads insurance bill PDFs under seguroComprovantesDir (see config/lanza_paths.json),
  extracts vehicle plate and premium amount, and writes Seguro expenses to
  database/parceiro-despesas.json. Use when syncing seguro, boletos de seguro, lote de seguros,
  comprovantes proteção veicular, or after adding PDFs to that folder.
---

# Sync seguro — Proteção Veicular

Lê **comprovantes / boletos de seguro** (PDF), extrai **placa** e **valor**, grava em `database/parceiro-despesas.json` (categoria `Seguro`). Alimenta **relatorio-prestacao-contas**.

## Onde estão os PDFs (canónico)

1. **Ler sempre primeiro** a pasta definida por **`seguroComprovantesDir`** em `config/lanza_paths.json` na raiz do repositório.
2. **Padrão atual:** `D:\Dropbox\Aluguel Carros\Proteção Veicular\Comprovantes\2026`
3. Listar **todos os `.pdf`** nessa pasta e, se existirem, **subpastas** (ex. `2026\06`, `2026\Junho`, por veículo, etc.) — não assumir só um nível de diretório.
4. Se o utilizador indicar outro caminho, prevalece para essa sessão; opcionalmente atualizar `seguroComprovantesDir` no JSON para fixar o novo padrão.

## Uso

- Preferir **um ficheiro PDF por veículo**; se existir `.jpg` e `.pdf` com o mesmo nome-base, usar só o **PDF** para extração de texto.
- `despesasRaiz` em `lanza_paths.json` serve para **outras despesas** em árvore `Despesas/...`; **não** substitui `seguroComprovantesDir` para seguros.

## Extração

| Campo | Onde |
|-------|------|
| `placa` | `PLACA(S): ...` e/ou nome do arquivo |
| `valor` | `( = ) Valor do Documento` / `(R$ xx,xx)` por placa |
| `data` | Vencimento DD/MM/AAAA |
| `competencia` | `CONTRIBUIÇÃO DO MÊS MM/AA` → `MM/AAAA` |

## Gravar

Montar lista JSON e executar (o ficheiro de entrada pode estar em `relatorios/` ou noutro caminho à escolha):

```bash
npx tsx src/run.ts sync-seguro "relatorios/_boletos_tmp.json"
```

Formato do JSON (array):

```json
[
  {
    "placa": "AVU6740",
    "valor": 74.85,
    "data": "10/06/2026",
    "competencia": "06/2026",
    "origem": "Proteção Veicular/Comprovantes/2026/AVU6740 - GOL.pdf"
  }
]
```

`origem` deve ser **única por ficheiro** (caminho relativo a `documentosRaiz` em `lanza_paths.json`, ou caminho absoluto normalizado) para dedupe na reimportação.

## Idempotência

- **Chaves:** `origem` (caminho PDF) **ou** `placa + competencia + Seguro`.
- Reexecutar `sync-seguro --scan ...` **atualiza** valores existentes; **não duplica** o mesmo boleto.
- Dois PDFs do **mesmo veículo/mês** colapsam num único registo (mantém o canónico).
- Ver também [`_idempotencia.md`](../_idempotencia.md).

## Espelhar no Rastreame (tela Manutenção)

Como toda despesa de parceiro, o seguro é espelhado na tela **Manutenção** do Rastreame:

```bash
npx tsx src/run.ts sync-manutencao --categoria Seguro --dry-run
npx tsx src/run.ts sync-manutencao --categoria Seguro
```

Idempotente (guarda `rastreameManutencaoId` em `parceiro-despesas.json`); o rastreável é resolvido pela placa. Ver tool **`.cursor/tools/rastreame/`**.

## Critério de conclusão

- Um registo por veículo sem duplicar jpg+pdf.
- `veiculoId` resolvido para o **uuid** do veículo ou `null` com aviso.

## Skills relacionadas

- **relatorio-prestacao-contas**, **cadastro-veiculo**, **cadastro-despesa**
