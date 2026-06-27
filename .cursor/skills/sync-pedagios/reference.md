# sync-pedagios — referência

Auth, endpoints e captura de sessão: **`.cursor/tools/pedagio-digital/reference.md`**.

## Mapeamento passagem → cliente-despesas.json

| Campo | Origem / valor |
|-------|----------------|
| `autoInfracao` | `PED-<id da passagem>` (chave única) |
| `categoria` | `Pedágio` |
| `veiculoId` | Placa (ABC-1D23) |
| `descricao` | `ATRASADO Pagamento pedágio {dd-mm-aaaa HH:mm}` |
| `dataAutuacao` | `DD/MM/AAAA HH:mm` da passagem (base para inferir condutor) |
| `valorMulta` | Valor da passagem |
| `localInfracao` | Praça / rodovia (quando houver) |
| `situacao` | `Em aberto` |
| `condutorId` / `condutorContrato` | Inferidos pelo contrato ativo na data (igual a infrações) |
| `condutorConfirmado` | `false` → revisar/confirmar antes de cobrar (tag confirmação) |
| `rastreameTipo` | `PEDAGIO` (usado no push ao Rastreame) |
| `origem` | `pedagio-digital` |

Só **passagens em aberto** são gravadas; as pagas são ignoradas pelo sync (visíveis em `pedagio-digital passagens --status pago`).

## Confirmar condutor (tag confirmação)

```bash
npx tsx src/run.ts gravar-cliente-despesa confirmar PED-<id>
```

## Relatório de lote

`relatorios/sync/_sync_pedagios.json` — resumo por placa (`novos`, `atualizados`, `ignorados`, avisos).

## Não confundir com

- **sync-infracoes** → mesma base, categoria `Infração` (DETRAN SC).
- **cadastro-despesa** → débitos do parceiro (`parceiro-despesas.json`), não pedágio de locatário.
