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

- **Arquivo:** PDF/imagem do CRLV (Read / visão). **Procurar primeiro** em `documentosRaiz` em `config/lanza_paths.json` (padrão `D:\Dropbox\Aluguel Carros`); em seguida pastas típicas de Downloads.
- **Destino:** `database/veiculos.json` (array `veiculos`). **`id`** = **uuid**; chave natural: **`placa`**. O script `merge_veiculo.py` define `id` ao gravar.

## Campos a extrair do CRLV

| Campo (JSON) | No documento |
|--------------|----------------|
| `placa` | `ABC-1D23` / `ABC-1234` |
| `marcaModelo` | ex.: `VW/GOL 1.0` |
| `anoModelo` | ex.: `2012/2013` |
| `chassi` | Chassi |
| `renavam` | RENAVAM |
| `cor` | Cor |
| `fipe` / `fipeCodigo` / `fipeModelo` / `fipeValor` / `fipeReferencia` | Via API (`fipe.py`). No contrato: `marcaModelo` + ` (fipeModelo)` quando preenchido. |

## Fipe (API)

Na raiz do repositório (PowerShell exemplo):

```bash
python ".cursor/skills/cadastrar-veiculo/scripts/fipe.py" marca "peugeot"
python ".cursor/skills/cadastrar-veiculo/scripts/fipe.py" modelos 44 2008 allure
python ".cursor/skills/cadastrar-veiculo/scripts/fipe.py" anos 44 7201 2021
python ".cursor/skills/cadastrar-veiculo/scripts/fipe.py" valor 44 7201 2021-5
```

### Atualizar FIPE em lote (`veiculos.json`)

Para recalcular **`fipe`**, **`fipeCodigo`**, **`fipeModelo`**, **`fipeValor`** e **`fipeReferencia`** a partir da API (mesma lógica do `fipe.py`), na raiz do repo:

```bash
node ".cursor/skills/cadastrar-veiculo/scripts/atualizar_fipe_veiculos.mjs"
node ".cursor/skills/cadastrar-veiculo/scripts/atualizar_fipe_veiculos.mjs" --placa ABC1D23
```

O script escolhe marca/modelo/ano com base em **`marcaModelo`**, **`anoModelo`** e **`fipeModelo`** (texto auxiliar). Ajustes manuais por placa ficam em **`EXTRAS_BY_PLACA`** no próprio script (ex.: motor `1.6` quando o CRLV não traz cilindrada, ou `4p` quando o `fipeModelo` estiver desatualizado). Em caso de divergência com o veículo real, corrija o registro no JSON ou refine os extras e rode de novo.

### Sincronizar dados do CRLV (PDF nas pastas)

PDFs nomeados pela **placa sem hífen** (ex.: `MLN0B87.pdf`) em qualquer subpasta de **`documentosRaiz`** (`config/lanza_paths.json`, ex.: `D:\Dropbox\Aluguel Carros\Ana - FORD FIESTA 2013-2014\`) ou em `veiculos/` na raiz do repo são lidos e os campos **`marcaModelo`**, **`anoModelo`**, **`chassi`**, **`renavam`** e **`cor`** em `database/veiculos.json` são atualizados quando o texto do PDF bate com os rótulos do CRLV.

Dependência: `py -m pip install -r requirements-tools.txt` (só **pypdf**).

```bash
py -3 ".cursor/skills/cadastrar-veiculo/scripts/sincronizar_veiculos_crlv.py" --dry-run
py -3 ".cursor/skills/cadastrar-veiculo/scripts/sincronizar_veiculos_crlv.py"
py -3 ".cursor/skills/cadastrar-veiculo/scripts/sincronizar_veiculos_crlv.py" --placa MLN-0B87
```

CRLV **escaneado** (imagem) pode não ter texto extraível; nesse caso use OCR ou mantenha o cadastro manual. Depois de alterar marca/ano, rode o sync FIPE (`atualizar_fipe_veiculos.mjs`) se quiser alinhar `fipe` / `fipeCodigo` / etc.

## Proprietário

Perguntar: parceiro existente (`database/parceiros.json`, **`id`** uuid) ou nome novo (gera `id` uuid automaticamente).

## Gravar

Montar objeto `veiculo` (sem `id`) + nome do proprietário em JSON temporário, depois:

```bash
python ".cursor/skills/cadastrar-veiculo/scripts/merge_veiculo.py" caminho/veiculo_tmp.json "Nome do Proprietario"
```

O script deduplica por **placa**, atualiza `parceiros.json` se necessário e recria o vínculo em `parceiro-veiculo.json`. **Em veículo novo** (`cadastrado`, não atualização por placa), após gravar, chama automaticamente `atualizar_fipe_veiculos.mjs --placa …` (precisa de **`node`** no PATH) para preencher/atualizar `fipe`, `fipeCodigo`, `fipeModelo`, `fipeValor` e `fipeReferencia`. Se `node` não existir ou a API falhar, aparece aviso no console; corrija dados ou `EXTRAS_BY_PLACA` e rode o `node` manualmente.

## Critério de conclusão

- CRLV extraído; consulta FIPE (`fipe.py` ou campos preenchidos antes do merge); proprietário coletado; confirmação antes de gravar.
- Sem duplicar placa.
- **Veículo novo:** após `merge_veiculo.py`, campos FIPE no JSON alinhados à API (automático com `node`, ou correção manual se houver aviso).

## Skills relacionadas

- **cadastrar-cliente**, **gerar-contrato**
