---
name: cadastrar-cliente
description: >-
  Registers a rental client (driver/lessee) by reading CNH (PDF/image) for
  personal data and a bill/proof of address (PDF/image) for the address, and
  writes to database/clientes.json. Use when the user asks to register a
  client, CNH, address proof, motorista, or update clientes.json.
---

# Cadastrar Cliente — CNH (PDF/imagem)

Skill para **cadastrar um cliente** (motorista/locatário) extraindo dados da **CNH** e do **comprovante de endereço**. Destino: `database/clientes.json` (na raiz do repositório).

## Uso

- O usuário anexa ou informa caminhos da **CNH** e do **comprovante** (PDF/JPG/PNG).
- **Procurar primeiro** em `documentosRaiz` definido em `config/lanza_paths.json` (padrão: `D:\Dropbox\Aluguel Carros` e subpastas). Depois `%USERPROFILE%\Downloads\` (ex.: `CNH-e.pdf`, `residencia.jpg`) — **sempre confirmar** com `Test-Path` / listagem antes de assumir.

## Fonte de dados

- **CNH:** dados pessoais + CNH.
- **Comprovante:** CEP, logradouro, número, complemento, bairro, cidade, UF. Telefone e e-mail: do comprovante se houver; senão **perguntar**.
- **Destino:** `database/clientes.json` (array `clientes`). Schema em `schemaCliente` no próprio arquivo. **`id`** = **uuid** (gerado pelo `merge_cliente.py`); chave natural: **`cpf`**.

## Campos a extrair da CNH

| Campo | Observação |
|-------|-----------|
| `nome` | Nome completo |
| `cpf` | CPF (`000.000.000-00`) |
| `rg` / `rgOrgaoExpedidor` | Doc. de identidade e órgão/UF |
| `dataNascimento` | DD/MM/AAAA |
| `cnh.numeroRegistro` | 11 dígitos |
| `cnh.categoria` | A, B, AB, C, D, E... |
| `cnh.primeiraHabilitacao` / `dataEmissao` / `validade` | DD/MM/AAAA |
| `cnh.numeroEspelho` | Nº espelho / segurança |
| `cnh.orgaoEmissor` / `cnh.ufEmissor` | DETRAN / UF |
| `cnh.ear` | true/false |
| `cnh.observacoes` | Observações |

> Endereço **não** vem da CNH; vem do comprovante (etapa 3).

## Campos do comprovante (boleto)

| Campo (JSON) | No boleto |
|--------------|-----------|
| `endereco.cep` | `00000-000` |
| `endereco.logradouro` | Rua/Avenida |
| `endereco.numero` | Número |
| `endereco.complemento` | Casa/Apto/Bloco |
| `endereco.bairro` | Bairro |
| `endereco.cidade` | Cidade |
| `endereco.uf` | UF |

> Conferir o **titular** do comprovante. Se for terceiro, confirmar com o usuário.

## Workflow

1. **Arquivos** — Obter caminhos da CNH e do comprovante (Read). Sem comprovante: seguir e perguntar endereço depois.
2. **CNH** — Extrair campos; ilegível → `null` + aviso.
3. **Comprovante** — Extrair endereço do titular.
4. **Confirmar** — Resumo completo antes de gravar.
5. **Gravar** — Montar objeto `cliente` (sem `id`), salvar JSON temporário e executar o merge por CPF:

```bash
python ".cursor/skills/cadastrar-cliente/scripts/merge_cliente.py" caminho/do/cliente_tmp.json
```

O script gera `id` (UUID), atualiza se CPF já existir e define `atualizadoEm`.

6. **Rastreame** (opcional, após gravar) — Verificar/cadastrar motorista:

```bash
python ".cursor/skills/cadastrar-cliente/scripts/rastreame.py" check "06852388310" "Nome Completo"
python ".cursor/skills/cadastrar-cliente/scripts/rastreame.py" add "database/_cliente_tmp.json"
```

Autenticação: variáveis `RASTREAME_LOGIN` + `RASTREAME_SENHA`, ou `RASTREAME_AUTH` (token manual, prioridade).

7. **Resultado** — Informar nome, CPF, `id` local e status no rastreame.

## Critério de conclusão

- Campos legíveis extraídos; confirmação antes de gravar.
- `database/clientes.json` atualizado sem duplicar CPF.

## Skills relacionadas

- Skill **cadastrar-veiculo** — CRLV → `veiculos.json`.
- Skill **gerar-contrato** — exige cliente e veículo cadastrados (ou cadastra no fluxo).
