# Tool — DETRAN SC (Detran Digital)

API `transito-api` em [servicos.detran.sc.gov.br](https://servicos.detran.sc.gov.br/). Consulta **placa + RENAVAM** de `database/veiculos.json`.

Dois comandos CLI (mesma auth, destinos diferentes):

| CLI | Destino | Doc |
|-----|---------|-----|
| `sync-infracoes` | `database/cliente-despesas.json` (Infração) | [infracoes.md](infracoes.md) |
| `sync-ipva-licenciamento` | `database/parceiro-despesas.json` (IPVA, Licenciamento) | [ipva-licenciamento.md](ipva-licenciamento.md) |

Referência API: [reference.md](reference.md)

## Autenticação (variáveis de ambiente do utilizador)

| Variável | Uso |
|----------|-----|
| `DETRAN_SC_AUTH` | JWT Bearer (sem prefixo `Bearer` no valor) |
| `DETRAN_SC_EMPRESA` | Header `X-Empresa` |
| `DETRAN_SC_APP_VERSION` | Opcional — header `X-App-Version` (pode ir no `.env`) |

Defina `DETRAN_SC_AUTH` e `DETRAN_SC_EMPRESA` nas variáveis de ambiente do utilizador — **não** em `.env`.

Token expira (~5 h). **Nunca** versionar no Git.

**Captcha** (Cloudflare Turnstile): o `requisitar-consulta` exige um token `c` no modo
`execute` com o `action` certo (`consulta_dossie_veiculo`) — o backend valida o action.

- **Automático (solver) — varredura 100% da frota**: `npx tsx scripts/detranSolver.ts`
  dirige um **Chrome real via CDP** (não detectado pelo Turnstile). Único passo manual: o
  **login gov.br** (a sessão persiste no perfil dedicado). O solver então **carrega o
  Turnstile sozinho**, mina um token `c` fresco por placa (sitekey+action conhecidos),
  consulta e ingere infrações + IPVA/licenciamento de toda a frota SC ativa. Ver
  [reference.md](reference.md) → "Solver".
- **Manual**: sem captcha, `requisitar-consulta` só devolve ticket se já houver consulta
  **pendente** para a placa (ex.: logo após consultar no portal) — senão `Captcha inválido`.

## Resumo rápido

```bash
# Varredura automática da frota (só com o login gov.br aberto)
npx tsx scripts/detranSolver.ts [--placa PLACA] [--dry-run]

# Infrações (locatário)
npx tsx src/run.ts sync-infracoes [--placa PLACA] [--dry-run]

# IPVA / licenciamento (parceiro)
npx tsx src/run.ts sync-ipva-licenciamento [--placa PLACA] [--dry-run]
```

Relatórios de lote: `relatorios/sync/_sync_infracoes.json`, `relatorios/sync/_sync_ipva_licenciamento.json`.

## Semântica `debitos[]` (mesma resposta API)

| Tipo no JSON | sync-infracoes | sync-ipva-licenciamento |
|--------------|----------------|-------------------------|
| Multa com auto | ✅ cliente-despesas | ❌ ignorar |
| IPVA | ❌ ignorar | ✅ parceiro-despesas |
| Licenciamento | ❌ ignorar | ✅ parceiro-despesas |

## Código

`src/lib/detranSc/` — `auth.ts`, `consulta.ts`, `mapInfracoes.ts`, `mapDebitosProprietario.ts`, `syncVeiculo.ts`, `syncDespesasVeiculo.ts`

Solver (Chrome real/CDP): `scripts/detranSolver.ts` + `scripts/detranBrowserHook.ts`

## Skills que usam esta tool

| Skill | CLI | Destino |
|-------|-----|---------|
| **sync-infracoes** | `sync-infracoes` | `database/cliente-despesas.json` |
| **sync-ipva-licenciamento** | `sync-ipva-licenciamento` | `database/parceiro-despesas.json` |

Outras skills relacionadas (consomem o JSON, não rodam sync):

- **cadastro-veiculo** — `renavam` obrigatório para consulta.
- **relatorio-encerramento-contrato** — infrações em `cliente-despesas.json`.
- **cadastro-despesa** — lançamento manual IPVA/licenciamento.
- **relatorio-prestacao-contas** — consome `parceiro-despesas.json`.
