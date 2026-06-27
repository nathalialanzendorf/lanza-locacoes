# DETRAN RS (PROCERGS) — referência técnica

## Base URL

```
https://pcsdetran.procergs.com.br/pcsdetran/rest
```

Origin / Referer: `https://pcsdetran.rs.gov.br/`

## Endpoint (confirmado 28/06/2026)

| Método | Path |
|--------|------|
| GET | `/veiculos/{PLACA}/?renavam={RENAVAM}&contabiliza=false` → dados completos do veículo |

**Sem ticket nem captcha** — uma única chamada devolve tudo. Bem mais simples que o SC.

Headers obrigatórios:

```
Authorization: Bearer <token>     ← DETRAN_RS_AUTH
X-User-Id: <base64 do CPF>         ← DETRAN_RS_USER_ID
Accept: application/json, text/plain, */*
```

## Estrutura da resposta (blocos usados)

| Bloco | Campos relevantes |
|-------|-------------------|
| `identificacao` | `placa`, `renavam`, `ufPlaca` (= "RS"), `marcaModelo`, `exercLicenciamento`, `dtVencLicenciamento` |
| `imposto.historico[]` | por exercício: `exercicio`, `situacao`, `dataVencimento`, `valorOriginal`, `debitos[]`, `dividaAtiva` |
| `imposto.historico[].debitos[]` | `descricao` (ex. "Cota Única"), `valorOriginal`, `valorTotalComDesconto` (com multa+juros), `valorMulta`, `valorJurosMulta`, `dataPagamento` |
| `expedicaoDocumento` | `vlrLic` (taxa de licenciamento), `txtSitLic` (texto com data limite), `exercRefLic` |
| `infracao` | **só totais**: `qtVencidas`/`vlVencidas`, `qtAVencer`/`vlAVencer`, `qtAgPrazoDef`, `qtAgPrazoJulg`, `qtSuspensas` — **sem lista por multa** |
| `seguro` | DPVAT (`situacaoExercAtual` etc.) |
| `licenciamento`, `restricao`, `furtadoRoubado` | situação documental / restrições |

### IPVA — quais entram

- Entra a entrada de `imposto.historico` cuja **`situacao` não seja paga** (`/liquidad|conclu|pago|quitad|baixad/i`) **e** que tenha `debitos[]`.
- Cada `debito` sem `dataPagamento` vira **uma** despesa IPVA (cota única e cada parcela coexistem — origem distinta).
- Valor gravado = `valorTotalComDesconto` (total atualizado com multa+juros), caindo para `valorOriginal` se ausente.

### Licenciamento

- `expedicaoDocumento.vlrLic > 0` → despesa Licenciamento do exercício `exercRefLic`.
- Vencimento extraído de `txtSitLic` ("Data limite para pagamento: DD/MM/AAAA") ou `identificacao.dtVencLicenciamento`.

### Infrações

- O endpoint devolve **apenas o resumo agregado**. Não há detalhe (auto, data de autuação, local). Quando há infrações (`total > 0`), o sync emite **aviso** para revisão manual — não grava em `cliente-despesas.json`.

## TLS

Em redes com interceção TLS → `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. Defina **`DETRAN_RS_TLS_INSECURE=1`** (também aceita `DETRAN_SC_TLS_INSECURE=1`/`RASTREAME_TLS_INSECURE=1`).

## Módulos

| Ficheiro | Função |
|----------|--------|
| `src/lib/detranRs/auth.ts` | Env + headers |
| `src/lib/detranRs/consulta.ts` | GET único |
| `src/lib/detranRs/mapDebitos.ts` | IPVA/Licenciamento + resumo de infrações |
| `src/lib/detranRs/syncVeiculo.ts` | Orquestra (frota RS, por placa, --json) |
| `src/cli/syncDetranRs.ts` | CLI `sync-detran-rs` |
| `scripts/capturarDetranRsToken.ts` | Login assistido gov.br (Playwright) + captura do token |
| `scripts/login-detran-rs.ps1` | Wrapper: roda a captura e grava `DETRAN_RS_AUTH`/`DETRAN_RS_USER_ID` |

## Autenticação: só gov.br (sem captcha próprio do DETRAN)

O `pcsdetran.rs.gov.br` autentica **exclusivamente pelo gov.br** (Login Cidadão / OAuth2 — `logincidadao.rs.gov.br` / `sso.acesso.gov.br`). Não existe captcha do DETRAN para "quebrar": o `Authorization: Bearer` (`DETRAN_RS_AUTH`) é o `access_token` emitido **no fim** do fluxo OAuth, e o gov.br usa **reCAPTCHA + MFA** (o JWT traz `amr: ["passwd","captcha","mfa","otp_offline"]`). Logo, **um humano precisa passar pelo reCAPTCHA/2FA** — não há login 100% desatendido.

### Login assistido (Playwright) — `scripts/login-detran-rs.ps1`

`scripts/capturarDetranRsToken.ts` abre um Chrome real e, ao ver pedidos a `pcsdetran.procergs.com.br`, captura:

- `Authorization` (Bearer, sem o prefixo) → `DETRAN_RS_AUTH`
- `X-User-Id` → `DETRAN_RS_USER_ID`

Escreve num ficheiro temporário do SO (fora do Dropbox, nunca imprime o token); o `login-detran-rs.ps1` lê-o, grava as variáveis do utilizador e apaga-o. Três modos de login (gratuitos), por ordem de prioridade:

| Modo | Como | Captcha? |
|------|------|----------|
| **Certificado A1 (Playwright)** | `DETRAN_RS_PFX_PATH`/`DETRAN_RS_PFX_PASS` (ou `DETRAN_PFX_*`) → `clientCertificates` do Playwright nas origens `certificado.sso.acesso.gov.br`/`sso.acesso.gov.br`; o `.pfx` legado é modernizado pelo openssl do Git (`-keypbe/-certpbe AES-256-CBC`) | **Não** (mTLS) |
| **Certificado do SO** | `--os-cert` → Chrome nativo usa o certificado do repositório do Windows (sem o proxy TLS interno do Playwright, que dá `ECONNRESET` em redes com interceção) | **Não** (mTLS) |
| **CPF/senha** | `DETRAN_RS_GOV_CPF`/`DETRAN_RS_GOV_SENHA` auto-preenchidos; **pausa** para o utilizador resolver reCAPTCHA/2FA | Sim (manual) |

Anti-detecção do reCAPTCHA (no modo CPF/senha): `--disable-blink-features=AutomationControlled`, `ignoreDefaultArgs:["--enable-automation"]` e `navigator.webdriver` escondido.

```powershell
.\scripts\login-detran-rs.ps1 -Pfx "C:\...\cert.pfx" -PfxPass "<senha>"  # certificado A1 (1ª vez)
.\scripts\login-detran-rs.ps1 -OsCert                                     # certificado do Windows
.\scripts\login-detran-rs.ps1 -Cpf "<cpf>" -Senha "<senha>"               # fallback CPF/senha
.\scripts\login-detran-rs.ps1 -Manual                                     # login todo à mão
.\scripts\login-detran-rs.ps1                                             # reusa o que ja foi guardado
```

### Captura manual (DevTools) — alternativa

1. [pcsdetran.rs.gov.br](https://pcsdetran.rs.gov.br/) logado.
2. DevTools → Network → pedido `veiculos/...`.
3. Copiar `Authorization` (Bearer) e `X-User-Id` → variáveis `DETRAN_RS_AUTH`, `DETRAN_RS_USER_ID`.

Debug offline: salvar a resposta e usar `--json arquivo.json --placa PLACA`.
