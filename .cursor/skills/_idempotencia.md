# Idempotência — regra transversal das skills Lanza

Toda skill que **grava** dados deve poder ser **reexecutada** sem duplicar registros.

## Princípios

1. **Chave de negócio** — cada sync define uma chave estável (ex.: `placa + competencia + categoria`, `autoInfracao`, `CPF`, `origem` do ficheiro).
2. **Upsert** — encontrou a chave → atualiza ou `sem_alteracao`; não encontrou → insere.
3. **Dedupe** — duplicatas antigas da mesma chave são removidas (mantém o registo canónico).
4. **Push externo (Rastreame)** — antes de POST, procurar registo remoto equivalente e **ligar** (`rastreameId` / `key`) em vez de criar outro.

## Por skill (resumo)

| Skill / CLI | Chave idempotente |
|-------------|-------------------|
| **cadastro-despesa** `gravar-rastreador` | `placa + competencia + Rastreador` · `origem: rastreador-fixo/...` |
| **sync-seguro** | `origem` (PDF) **ou** `placa + competencia + Seguro` |
| **sync-ipva-licenciamento** | `origem: detran-sc/debitos/...` |
| **sync-infracoes** | `autoInfracao` |
| **sync-gastos-gerais** pull | `rastreameId` / `RAST-{id}` |
| **sync-gastos-gerais** push | `info + motorista + rastreavel` (antes de POST) |
| **sync-manutencao** push | `rastreameManutencaoId` local; dedupe `rastreavel + info + data` antes de POST |
| **sync-cliente** | CPF / CNH / `rastreameMotoristaKey` / nome |
| **sync-veiculo** | `placa` / `rastreameRastreavelKey` |
| **cadastro-despesa** | `placa + competencia + categoria + descricao` (manual) |
| **cadastro-cliente** | CPF / CNH |
| **cadastro-veiculo** | `placa` |
| **cadastro-contrato** sincronizar | `pastaContrato` |
| **gravar-cliente-despesa** | `autoInfracao` |

Skills **só leitura** (relatórios) não gravam — idempotência N/A.

## Verificação

Após sync, correr de novo com `--dry-run` ou repetir o comando: esperar **0 novos** e **sem alteração** (ou só atualizações se dados externos mudaram).
