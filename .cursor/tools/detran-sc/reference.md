# DETRAN SC — referência técnica

## Base URL

```
https://backend.detran.sc.gov.br/transito-api
```

Origin / Referer: `https://servicos.detran.sc.gov.br/`

## Endpoints (confirmados 27/06/2026)

| Etapa | Método | Path |
|-------|--------|------|
| Iniciar consulta | GET | `/veiculo/requisitar-consulta?p={placa}&r={renavam}&c={captcha}&v=` → devolve o ticket (UUID) |
| Resposta | GET | `/veiculo/resposta-consulta?t={uuid}` → dados do veículo |

> O endpoint antigo `POST /veiculo/consulta` foi **descontinuado** (responde HTTP 404).

Headers: `Authorization`, `X-Empresa`, `X-App-Version` (ver [README.md](README.md)).

## Captcha Cloudflare Turnstile — como o portal o resolve (confirmado 28/06/2026)

O parâmetro **`c`** do `requisitar-consulta` é um **token Cloudflare Turnstile**. O
portal **não** usa um widget visível: ele gera o token em modo `execute`, com um
**`action`** que o backend **valida**. Fluxo extraído do bundle `index-*.js`:

```js
wid = turnstile.render(div, { sitekey, appearance: "execute" });   // div oculto
turnstile.execute(wid, { action, callback, "error-callback", ... });
```

- **Sitekey** (estático do site): `0x4AAAAAACHoBaRqG-bgkhK1`.
- **`action` por serviço** (cada `$turnstile("<action>")` num chunk). O do **dossiê
  de veículo** (infrações + débitos) é **`consulta_dossie_veiculo`**.
- Minar com render imediato e **sem `action`** → o backend responde **`Captcha
  inválido`**. Minar no modo `execute` com o `action` certo → token aceito.

### Resposta assíncrona (pendente → dossiê)

`requisitar-consulta?...&c=<token>` devolve um **ticket** (`token`/uuid). O
`resposta-consulta?t=<uuid>` devolve **`{placa, pendente:true, ...}`** enquanto
monta o dossiê e, quando pronto, o dossiê completo com **`pendente:false`** +
`infracoes`/`historicoInfracoes`/`debitos`. **Não** tratar `pendente:true` como
final — continuar o polling até `pendente:false`.

### Solver — varredura 100% automática da frota (`detran-sc-solver`)

O token Turnstile só é válido num browser **real** (não-automatizado). O solver
`scripts/detranSolver.ts` dirige um **Chrome nativo via CDP** (o Turnstile não o
detecta) e faz tudo sozinho: **carrega o próprio Turnstile** (injeta o `api.js`),
mina um token `c` **fresco por placa** com o `sitekey`+`action` corretos, consulta
na própria origem do portal e ingere infrações + IPVA/licenciamento de toda a
frota SC ativa.

```bash
# Varredura automática da frota (só precisa do login gov.br aberto)
npx tsx scripts/detranSolver.ts [--placa PLACA] [--dry-run] [--so-token]
# alias via run.ts:
npx tsx src/run.ts detran-sc-solver [--placa PLACA] [--dry-run]
```

Como funciona (1 passo manual: o login):
1. O solver abre um **Chrome com perfil dedicado** (a sessão gov.br **persiste**
   entre execuções). Na 1ª vez você faz o **login gov.br** (o certificado A1 é
   apresentado pela política `AutoSelectCertificateForUrls`, se configurada — ver
   `--setup-cert` abaixo; senão escolhe-se o cert à mão **uma vez**). Depois, basta
   deixar a janela aberta — **não é preciso fazer consulta manual**.
2. **Credenciais de API**: o JWT (`Authorization`) é capturado da rede do portal
   **ou** do `storage` (`__lanzaScanToken`). `X-Empresa`/`X-App-Version` são
   capturados da rede quando presentes (não são exigidos para a consulta logada).
3. **Token**: `window.__lanzaMint(sitekey, action)` carrega o Turnstile se preciso
   e mina o token no modo `execute` com `action=consulta_dossie_veiculo`.
4. **Consulta**: `window.__lanzaConsulta(...)` roda na própria aba (mesma origem/IP)
   → `requisitar-consulta` + polling do `resposta-consulta` até `pendente:false`.

Overrides por env (raramente necessários):
- `DETRAN_SC_TURNSTILE_SITEKEY` — troca o sitekey (default = constante acima).
- `DETRAN_SC_TURNSTILE_ACTION` — troca o action (default `consulta_dossie_veiculo`).

Flags:
- `--placa PLACA` — só essa placa; `--dry-run` — não grava nos `*-despesas.json`.
- `--so-token` — só mina um token e grava num arquivo temp do SO (para usar com
  `sync-infracoes --captcha "<c>" --placa PLACA`).
- `--setup-cert` — prepara o login por certificado A1 (import do `.pfx` + política
  `AutoSelectCertificateForUrls`). Env: `DETRAN_PFX_PATH`, `DETRAN_PFX_PASS`.

> Usa o **Chrome instalado** + `ws` (CDP) — não precisa de Playwright. O token
> `DETRAN_SC_AUTH` expira ~5 h; basta reabrir/relogar que o solver recaptura.

### Modos manuais (sem solver)

| Caso | Como |
|------|------|
| Uma placa **logo após** consultar no portal | `sync-infracoes --placa PLACA` (reaproveita o ticket pendente, sem captcha) |
| Ticket `t` capturado no DevTools | `sync-infracoes --ticket <t> --placa PLACA` |
| Resposta JSON salva (offline) | `sync-infracoes --json arquivo.json --placa PLACA` |

> Sem o solver e sem pendência, `requisitar-consulta` sem captcha devolve
> `Captcha inválido`. Token `DETRAN_SC_AUTH` expira ~5 h → `HTTP 401` = recapturar.

## TLS

Nesta máquina há interceção TLS (proxy/antivírus) → `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.
Defina **`DETRAN_SC_TLS_INSECURE=1`** (a tool também aceita `RASTREAME_TLS_INSECURE=1` como fallback).

## Classificação `debitos[]`

| Texto | sync-infracoes | sync-ipva-licenciamento |
|-------|----------------|-------------------------|
| multa / `numeroAuto` | ✅ | ❌ |
| IPVA | ❌ | ✅ |
| Licenciamento | ❌ | ✅ |
| DPVAT, taxa DETRAN, CRLV | ❌ | ❌ |

## Módulos

| Ficheiro | Função |
|----------|--------|
| `src/lib/detranSc/auth.ts` | Env + headers |
| `src/lib/detranSc/consulta.ts` | POST + poll |
| `src/lib/detranSc/mapInfracoes.ts` | Infrações |
| `src/lib/detranSc/mapDebitosProprietario.ts` | IPVA/licenciamento |
| `src/lib/detranSc/syncVeiculo.ts` | Orquestra infrações |
| `src/lib/detranSc/syncDespesasVeiculo.ts` | Orquestra parceiro |
| `src/cli/syncInfracoes.ts` | CLI infrações |
| `src/cli/syncIpvaLicenciamento.ts` | CLI IPVA/licenciamento |
| `scripts/detranSolver.ts` | Solver Turnstile + login (Chrome real/CDP), varredura da frota; sitekey/action conhecidos |
| `scripts/detranBrowserHook.ts` | JS injetado: `__lanzaEnsureTurnstile` (carrega api.js), `__lanzaMint` (render+execute+action), `__lanzaConsulta` (requisitar+poll), `__lanzaScanToken`, `__lanzaClick` |
| `scripts/detranCertSetup.ps1` | Login por cert A1: import do `.pfx` + política `AutoSelectCertificateForUrls` |

## Capturar token

1. [servicos.detran.sc.gov.br](https://servicos.detran.sc.gov.br/) logado.
2. DevTools → Network → `transito-api`.
3. Consultar veículo → copiar `Authorization` (JWT) e `X-Empresa`.

Debug offline: `--json relatorios/_tmp/_detran_resposta.json`.
