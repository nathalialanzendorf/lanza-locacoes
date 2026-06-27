---
name: cadastro-cliente
description: >-
  CRUD of rental clients (driver/lessee): create, edit, delete in database/clientes.json
  from CNH and address proof. Use when the user asks to register, edit, or remove a
  client, CNH, motorista, or clientes.json.
---

# Cadastro de cliente — CNH (PDF/imagem)

Skill para **cadastrar, editar e excluir** clientes (motoristas/locatários) em `database/clientes.json`, mantendo o espelho no Rastreame (motorista).

## Regra de dados (Rastreame × database)

- O **Rastreame** guarda **apenas os campos nativos** do motorista: `nome`, `cpf`, `cnh` (número), `categoriaCnh`, `vencimentoCnh`, `contato` (celular/e-mail).
- O campo **`observacao` do Rastreame NÃO é usado** (nem escrito, nem lido). Não popular observação ao cadastrar.
- Os **demais campos** (endereço, RG/órgão, nascimento, filiação, nº espelho, órgão emissor/UF, 1ª habilitação, EAR, observações) **só existem na database cliente** — nunca vão para o Rastreame.

## Operações

| Operação | Como |
|----------|------|
| **Cadastrar** | Confirmar arquivos → ler → criar no Rastreame (nativo) → sincronizar → enriquecer database |
| **Editar** | Novo JSON parcial → `merge-cliente` (mesmo CPF); **sync-cliente** replica os campos nativos |
| **Excluir** | Remover entrada do array `clientes` em `clientes.json` (confirmar com operador) |

## Fonte de dados

- **CNH:** dados pessoais + CNH.
- **Comprovante:** CEP, logradouro, número, complemento, bairro, cidade, UF. Telefone e e-mail: do comprovante se houver; senão **perguntar**.
- **Destino:** `database/clientes.json` (array `clientes`). Schema em `schemaCliente` no próprio arquivo. **`id`** = **uuid** (gerado pelo merge TypeScript); chave natural: **`cpf`**.

## Campos a extrair da CNH

| Campo | Vai para o Rastreame? | Observação |
|-------|-----------------------|-----------|
| `nome` | ✅ nativo | Nome completo |
| `cpf` | ✅ nativo | CPF (`000.000.000-00`) |
| `cnh.numeroRegistro` | ✅ nativo (`cnh`) | 11 dígitos |
| `cnh.categoria` | ✅ nativo (`categoriaCnh`) | A, B, AB, C, D, E... |
| `cnh.validade` | ✅ nativo (`vencimentoCnh`) | DD/MM/AAAA |
| `rg` / `rgOrgaoExpedidor` | ❌ só database | Doc. de identidade e órgão/UF |
| `dataNascimento` / `localNascimento` | ❌ só database | DD/MM/AAAA + local |
| `filiacao` | ❌ só database | Filiação (mãe/pai) |
| `cnh.primeiraHabilitacao` / `dataEmissao` | ❌ só database | DD/MM/AAAA |
| `cnh.numeroEspelho` | ❌ só database | Nº espelho / segurança |
| `cnh.orgaoEmissor` / `cnh.ufEmissor` | ❌ só database | DETRAN / UF |
| `cnh.ear` | ❌ só database | true/false |
| `cnh.observacoes` | ❌ só database | Observações da CNH |

> Endereço **não** vem da CNH; vem do comprovante.

## Campos do comprovante (boleto) — só database

| Campo (JSON) | No boleto |
|--------------|-----------|
| `endereco.cep` | `00000-000` |
| `endereco.logradouro` | Rua/Avenida |
| `endereco.numero` | Número |
| `endereco.complemento` | Casa/Apto/Bloco |
| `endereco.bairro` | Bairro |
| `endereco.cidade` | Cidade |
| `endereco.uf` | UF |
| `telefone` / `email` | ✅ vão como `contato` nativo no Rastreame |

> Conferir o **titular** do comprovante. Se for terceiro, confirmar com o usuário.

## Workflow (cadastrar)

1. **PRIMEIRA AÇÃO — confirmar os arquivos.** Antes de qualquer leitura, **confirmar a localização da CNH e do comprovante de residência**. Procurar em `documentosRaiz` do `config/lanza_paths.json` (padrão `D:\Dropbox\Aluguel Carros` e subpastas) e em `%USERPROFILE%\Downloads\`; **sempre validar com `Test-Path`/listagem** e confirmar com o operador. Sem os dois documentos, perguntar antes de prosseguir.
2. **Ler e extrair** — CNH: dados pessoais + CNH. Comprovante: endereço (+ telefone/e-mail se houver). Campo ilegível → `null` + aviso.
3. **Confirmar** — resumo completo com o operador antes de gravar.
4. **Criar no Rastreame (sem observação)** — montar `cliente_tmp.json` com **todos** os campos extraídos (o `rastreame add` envia só os nativos; observação fica vazia):

```bash
npx tsx src/run.ts rastreame check "<cnh>" "<nome>"   # evitar duplicado
npx tsx src/run.ts rastreame add caminho/cliente_tmp.json
```

5. **Sincronizar com a database** — importa o motorista recém-criado e cria o registro local com os campos nativos, estabelecendo o vínculo `rastreameMotoristaKey`:

```bash
npx tsx src/run.ts sync-motoristas --pull-only
```

6. **Atualizar os demais campos (só na database)** — gravar os campos que o Rastreame não tem (endereço, RG, nascimento, filiação, espelho, órgão emissor, etc.) usando o mesmo `cliente_tmp.json`; casa por CPF e não duplica:

```bash
npx tsx src/run.ts merge-cliente caminho/cliente_tmp.json
```

7. **Resultado** — informar nome, CPF, `id` local, `rastreameMotoristaKey` e status.

**Importação em lote (CNH nas pastas de contrato):**

```bash
npx tsx src/run.ts importar-clientes-cnh --dry-run
npx tsx src/run.ts importar-clientes-cnh
npx tsx src/run.ts importar-clientes-cnh --com-rastreame   # enriquece CNH via API Rastreame
```

Varre `documentosRaiz` (`D:\Dropbox\Aluguel Carros`), pastas `DD.MM.AAAA - Nome`, arquivos `CNH*` (pdf/jpg/png…). Nome/CPF/endereço vêm do `Contrato*.docx` na mesma pasta.

## Idempotência

- **Chave:** `cpf` (preferencial), depois CNH, depois `rastreameMotoristaKey`, e por fim **nome normalizado** (evita duplicar quem já existe sem CPF/CNH casado).
- `merge-cliente` com mesmo CPF **atualiza**; não duplica.
- `rastreame add` verifica duplicado (CNH/nome) antes de criar.
- Ver [`_idempotencia.md`](../_idempotencia.md).

## Critério de conclusão

- Arquivos confirmados antes da leitura; campos legíveis extraídos; confirmação antes de gravar.
- Motorista no Rastreame **sem observação**, só com campos nativos.
- `database/clientes.json` atualizado (com os campos extras), vinculado por `rastreameMotoristaKey`, sem duplicar CPF.

## Skills relacionadas

- Skill **sync-cliente** — sincroniza Rastreame ↔ `clientes.json` (mesma regra: só campos nativos, sem observação).
- Tool **Rastreame** (`.cursor/tools/rastreame/`) — comandos no site (motorista, gastos).
- Skill **cadastro-veiculo** — CRLV → `veiculos.json`.
- Skill **cadastro-contrato** — exige cliente e veículo cadastrados (ou cadastra no fluxo).
