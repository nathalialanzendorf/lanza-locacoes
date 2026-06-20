---
name: cadastrar-veiculo
description: >-
  Registers a vehicle by reading the CRLV/vehicle document (PDF or image) and
  writes to database/veiculos.json with FIPE lookup and owner link in
  parceiro-veiculo.json. Use when the user asks to register a vehicle, CRLV,
  placa, or update veiculos.json.
---

# Cadastrar Veículo — CRLV (PDF/imagem)

Skill para **cadastrar um veículo** a partir do **CRLV** (PDF ou imagem). Destino: `database/veiculos.json` + vínculo em `database/parceiro-veiculo.json`.

## Fonte e destino

- **Arquivo:** PDF/imagem do CRLV (Read / visão).
- **Destino:** `database/veiculos.json` (array `veiculos`).

## Campos a extrair do CRLV

| Campo (JSON) | No documento |
|--------------|----------------|
| `placa` | `ABC-1D23` / `ABC-1234` |
| `marcaModelo` | ex.: `VW/GOL 1.0` |
| `descricao` | Versão completa |
| `anoModelo` | ex.: `2012/2013` |
| `chassi` | Chassi |
| `renavam` | RENAVAM |
| `cor` | Cor |
| `fipe` / `codigoFipe` / `modeloFipe` / `fipeValor` / `fipeReferencia` | Via API (script `fipe.py`) |

## Fipe (API)

Na raiz do repositório (PowerShell exemplo):

```bash
python ".cursor/skills/cadastrar-veiculo/scripts/fipe.py" marca "peugeot"
python ".cursor/skills/cadastrar-veiculo/scripts/fipe.py" modelos 44 2008 allure
python ".cursor/skills/cadastrar-veiculo/scripts/fipe.py" anos 44 7201 2021
python ".cursor/skills/cadastrar-veiculo/scripts/fipe.py" valor 44 7201 2021-5
```

## Proprietário

Perguntar: parceiro existente (`database/parceiros.json`) ou empresa **Lanza Locações**.

## Gravar

Montar objeto `veiculo` (sem `id`) + nome do proprietário em JSON temporário, depois:

```bash
python ".cursor/skills/cadastrar-veiculo/scripts/merge_veiculo.py" caminho/veiculo_tmp.json "Nome do Proprietario"
```

O script deduplica por **placa**, atualiza `parceiros.json` se necessário e recria o vínculo em `parceiro-veiculo.json`.

## Critério de conclusão

- CRLV extraído; Fipe e proprietário coletados; confirmação antes de gravar.
- Sem duplicar placa.

## Skills relacionadas

- **cadastrar-cliente**, **gerar-contrato**
