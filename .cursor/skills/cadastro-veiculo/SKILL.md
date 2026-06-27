---
name: cadastro-veiculo
description: >-
  CRUD vehicles from CRLV in database/veiculos.json with FIPE and owner link.
  Use when registering, editing, or removing a vehicle, CRLV, or placa.
---

# Cadastro de veículo — CRLV (PDF/imagem)

Skill para **cadastrar, editar e excluir** veículos em `database/veiculos.json` + vínculo em `parceiro-veiculo.json`.

## Operações

| Operação | Como |
|----------|------|
| **Cadastrar** | CRLV → `merge-veiculo` |
| **Editar** | Novo JSON → `merge-veiculo` (mesma placa) ou `atualizar-fipe-veiculos` |
| **Excluir** | Remover de `veiculos.json` (confirmar; verificar contratos ativos) |

## Fonte e destino

- **Arquivo:** PDF/imagem do CRLV (Read / visão). **Procurar primeiro** em `documentosRaiz` em `config/lanza_paths.json` (padrão `D:\Dropbox\Aluguel Carros`); em seguida pastas típicas de Downloads.
- **Destino:** `database/veiculos.json` (array `veiculos`). **`id`** = **uuid**; chave natural: **`placa`**. O comando `merge-veiculo` (TypeScript) define `id` ao gravar.

## Campos a extrair do CRLV

| Campo (JSON) | No documento |
|--------------|----------------|
| `placa` | `ABC-1D23` / `ABC-1234` |
| `marcaModelo` | ex.: `VW/GOL 1.0` |
| `anoModelo` | ex.: `2012/2013` |
| `chassi` | Chassi |
| `renavam` | RENAVAM |
| `cor` | Cor |
| `ufRegistro` | **UF da placa** (ex.: `SC`, `RS`). Define qual DETRAN consultar: SC/ausente → `sync-infracoes`/`sync-ipva-licenciamento`; `RS` → `sync-detran-rs`. Gravar quando a placa for de fora de SC. |
| `fipe` / `fipeCodigo` / `fipeModelo` / `fipeValor` / `fipeReferencia` | Via API (comando `fipe`). No contrato: `marcaModelo` + ` (fipeModelo)` quando preenchido. |

## Ferramentas TypeScript (`src/` na raiz do repo)

Na **raiz do repositório**, após `npm install` na raiz:

```text
npx tsx src/run.ts <subcomando> ...
```

## Fipe (API)

Consulta FIPE isolada na **tool `fipe`** (`.cursor/tools/fipe/`, código em `src/lib/fipe/`) — reutilizável por esta skill e por outras. CLI:

```bash
npx tsx src/run.ts fipe marca "peugeot"
npx tsx src/run.ts fipe modelos 44 2008 allure
npx tsx src/run.ts fipe anos 44 7201 2021
npx tsx src/run.ts fipe valor 44 7201 2021-5
```

### Atualizar FIPE em lote (`veiculos.json`)

```bash
npx tsx src/run.ts atualizar-fipe-veiculos
npx tsx src/run.ts atualizar-fipe-veiculos --placa ABC1D23
```

O script escolhe marca/modelo/ano com base em **`marcaModelo`**, **`anoModelo`** e **`fipeModelo`** (texto auxiliar). Ajustes manuais por placa ficam em **`EXTRAS_BY_PLACA`** em `src/lib/fipe/resolverVeiculo.ts`. Em caso de divergência com o veículo real, corrija o registro no JSON ou refine os extras e rode de novo.

### Sincronizar dados do CRLV (PDF nas pastas)

PDFs nomeados pela **placa sem hífen** (ex.: `MLN0B87.pdf`) em qualquer subpasta de **`documentosRaiz`** (`config/lanza_paths.json`, ex.: `D:\Dropbox\Aluguel Carros\Ana - FORD FIESTA 2013-2014\`) ou em `veiculos/` na raiz do repo são lidos e os campos **`marcaModelo`**, **`anoModelo`**, **`chassi`**, **`renavam`** e **`cor`** em `database/veiculos.json` são atualizados quando o texto do PDF bate com os rótulos do CRLV.

Dependência: `npm install` na raiz do repositório (pacote **`pdf-parse`**).

```bash
npx tsx src/run.ts sincronizar-veiculos-crlv --dry-run
npx tsx src/run.ts sincronizar-veiculos-crlv
npx tsx src/run.ts sincronizar-veiculos-crlv --placa MLN-0B87
```

CRLV **escaneado** (imagem) pode não ter texto extraível; nesse caso use OCR ou mantenha o cadastro manual. Depois de alterar marca/ano, rode `atualizar-fipe-veiculos` se quiser alinhar `fipe` / `fipeCodigo` / etc.

## Proprietário

Perguntar: parceiro existente (`database/parceiros.json`, **`id`** uuid) ou nome novo (gera `id` uuid automaticamente).

## Veículo particular (regra Nivus / ICZ-2H47)

Carro **particular do proprietário** (não é de locação) recebe `"particular": true` no registro. Cadastrar com `merge-veiculo … --no-sync-rastreame` (não cria rastreável no Rastreame).

**PODE ter (rastreado normalmente):** seguro, pedágio, IPVA, estacionamento rotativo, licenciamento, infrações e **tabela FIPE**. Entra nos syncs DETRAN — basta `ativo: true` + `renavam`. Por UF: SC/ausente → `sync-infracoes`/`sync-ipva-licenciamento`; `ufRegistro="RS"` → `sync-detran-rs` (tool `.cursor/tools/detran-rs/`).

**NÃO tem / NÃO entra:**
- **Rastreador** (não paga taxa mensal `sync-rastreador`) → logo **sem registro no Rastreame** (`isSyncRastreameEligible` retorna false).
- **Despesas/cobranças de locação** → `relatorio-cobrancas` recusa gerar cobrança de locatário para placa particular.
- **Prestação de contas** → `montar-relatorio` pula veículos particulares.
- **Quebra/encerramento de contrato** → `calcularEncerramentoContrato` recusa placa particular.

## Gravar

Montar objeto `veiculo` (sem `id`) + nome do proprietário em JSON temporário, depois:

```bash
npx tsx src/run.ts merge-veiculo caminho/veiculo_tmp.json "Nome do Proprietario"
```

O script deduplica por **placa**, atualiza `parceiros.json` se necessário e recria o vínculo em `parceiro-veiculo.json`. **Em veículo novo** (`cadastrado`, não atualização por placa), após gravar, chama automaticamente a sincronização FIPE (`atualizar-fipe-veiculos --placa …`) no mesmo processo para preencher/atualizar `fipe`, `fipeCodigo`, `fipeModelo`, `fipeValor` e `fipeReferencia`. Se a API falhar, aparece aviso no console; corrija dados ou `EXTRAS_BY_PLACA` e rode `atualizar-fipe-veiculos` manualmente.

### Cadastrar placa no Pedágio Digital (veículo novo)

Em **veículo novo**, cadastrar também a placa no **pedagiodigital.com** (tool `pedagio-digital`, ver `.cursor/tools/pedagio-digital/`) para depois sincronizar passagens via skill **sync-pedagios**:

```bash
npx tsx src/run.ts pedagio-digital register --placa ABC1D23
```

O portal só guarda o campo `modelo`, então a tool o **compõe** com modelo+marca+ano+cor (ex.: `"GOL 1.0 VOLKSWAGEN 2013 PRATA"`), lidos de `veiculos.json`. Overrides: `--modelo` (texto literal), `--marca`, `--ano`, `--cor`. Requer `PEDAGIO_DIGITAL_COOKIE` e `PEDAGIO_DIGITAL_CSRF` (variáveis de ambiente do utilizador).

### Excluir placa do Pedágio Digital (ao inativar veículo)

Sempre que um veículo for **inativado** (`ativo: false` em `veiculos.json`), **excluir** a placa do pedagiodigital.com — não cobramos pedágio de veículo fora de locação:

```bash
npx tsx src/run.ts pedagio-digital delete --placa ABC1D23
```

Idempotente (se a placa não estiver no portal, sai OK sem fazer nada). Use `--dry-run` para conferir o id antes de excluir.

## Idempotência

- **Chave:** `placa` (normalizada).
- `merge-veiculo` com mesma placa **atualiza**; vínculo parceiro substituído, não duplicado.
- Ver [`_idempotencia.md`](../_idempotencia.md).

## Critério de conclusão

- CRLV extraído; consulta FIPE (comando `fipe` ou campos preenchidos antes do merge); proprietário coletado; confirmação antes de gravar.
- Sem duplicar placa.
- **Veículo novo:** após `merge-veiculo`, campos FIPE no JSON alinhados à API (automático no mesmo fluxo, ou correção manual se houver aviso).

## Skills relacionadas

- **cadastro-cliente**, **cadastro-contrato**
- **sync-pedagios** — após cadastrar a placa no Pedágio Digital, sincroniza passagens em aberto.
