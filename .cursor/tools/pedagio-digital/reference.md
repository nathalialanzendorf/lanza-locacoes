# Pedágio Digital — referência técnica

## Base URL

```
https://pedagiodigital.com/bff/api
```

Origin: `https://pedagiodigital.com` · Referer típico: `https://pedagiodigital.com/` (em `register`, `/add-veiculo`).

## Endpoints

| Operação | Método | Path | Estado |
|----------|--------|------|--------|
| Login (CPF+senha) | POST | `/bff/login` *(fora de `/bff/api`)* | **confirmado** |
| Cadastrar placa | POST | `/Placa/register` | **confirmado** |
| Excluir placa | POST | `/Placa/delete/{idUsuarioPlaca}` *(sem corpo)* | **confirmado (27/06/2026)** |
| Listar veículos | GET | `/Placa/list` *(fallbacks: `/Placa`, `/Placa/listar`, `/Veiculo`)* | **confirmado** |
| Passagens (todas as placas) | GET | `/Passagem/list-logado?placas=P1,P2,...` | **confirmado (27/06/2026)** |

> **Passagens numa só chamada:** `list-logado` recebe `placas` = lista de placas
> **compactas** (sem hífen), separadas por vírgula, e devolve as passagens de todas
> elas (cada item traz a sua placa). A tool faz **1 pedido para a frota inteira** —
> muito mais robusto, pois a sessão do BFF expira em poucos minutos.

> Os GET de `/bff/api` enviam **cookie + `x-csrf-token`** (não só nos POST).

> **TLS:** nesta máquina há interceção TLS (antivírus/proxy) → defina `PEDAGIO_DIGITAL_TLS_INSECURE=1` (igual a `RASTREAME_TLS_INSECURE`) se o Node falhar com `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.

> **Akamai:** chamar `www.pedagiodigital.com` por `curl` é barrado pelo bot manager (HTTP 403 `edgesuite`). Use o host **sem `www`** (`pedagiodigital.com`), como a tool faz.

> **Sessão curta → use offline:** se a sessão expirar (HTTP 401 `unauthorized`),
> salve a resposta de `list-logado` (DevTools → Response → Save) e rode
> `sync-pedagios --json arquivo.json` (processa toda a frota, sem API).

### POST `/Placa/register` (confirmado)

Body mínimo (campos confirmados no portal):

```json
{ "placa": "IYR8F19", "modelo": "GOL 1.0", "cdStatus": true, "blPlacaInternacional": false }
```

**Comportamento confirmado (27/06/2026):** o `register` responde 200
`"Status da placa atualizado com sucesso."` e **só persiste `modelo`** (e `cdStatus`).
A entidade devolvida por `Placa/list` tem `marca`/`ano`/`cor`, mas o `register`
**não os grava** (voltam `null`) — o formulário `add-veiculo` também só envia `placa`+`modelo`.

➡️ Por isso a tool **concatena** as infos no único campo que persiste:
`modelo = "MODELO MARCA ANO COR"` (ex.: `"GOL 1.0 VOLKSWAGEN 2013 PRATA"`), a partir de
`modelo`/`marca`/`ano`(ou 1ª parte de `anoModelo`)/`cor` do `veiculos.json`.

```json
{ "placa": "AVU6740", "modelo": "GOL 1.0 VOLKSWAGEN 2013 PRATA", "cdStatus": true, "blPlacaInternacional": false }
```

- A tool ainda envia `marca`/`ano`/`cor` à parte (ignorados hoje; future-proof se o BFF passar a aceitar).
- Overrides na CLI: `register --placa P [--modelo M] [--marca M] [--ano A] [--cor C]` (com `--modelo`, usa o texto informado, sem compor).

### POST `/Placa/delete/{idUsuarioPlaca}` (confirmado 27/06/2026)

Exclui a placa da conta. **`POST` sem corpo** (`content-length: 0`); o `id` é o
`idUsuarioPlaca` que vem em `Placa/list` (a tool resolve placa → id sozinha).

➡️ **Regra:** ao **inativar** um veículo no `database/veiculos.json` (`ativo: false`),
excluí-lo do Pedágio — não cobramos pedágio de veículo fora de locação.

- CLI: `pedagio-digital delete --placa PLACA [--dry-run]`.
- Idempotente: se a placa não estiver no portal, não faz nada (sai OK).

## Headers

`accept: application/json`, `content-type: application/json`, `origin`, `referer`, `user-agent`, `cookie` (= `PEDAGIO_DIGITAL_COOKIE`), `x-csrf-token` (= `PEDAGIO_DIGITAL_CSRF`).

## Campos de passagem (parsing resiliente)

O normalizador procura, por ordem, vários nomes possíveis:

| Campo lógico | Chaves tentadas |
|--------------|-----------------|
| id (chave natural) | `id`, `idPassagem`, `idTransacao`, `nrTransacao`, `codigo`, `protocolo`, `uuid` |
| placa | `placa`, `nrPlaca`, `plate` |
| data/hora | `dataHora`, `dataHoraPassagem`, `dtPassagem`, `data`, `dtTransacao`, `dataTransacao` |
| valor | `valor`, `vlPassagem`, `vlPedagio`, `valorPedagio`, `total`, `vlTotal` |
| praça | `praca`, `pracaPedagio`, `dsPraca`, `nomePraca`, `concessionaria` |
| status | `status`, `situacao`, `dsStatus`, `statusPagamento`, `stPagamento` (+ flags `pago`/`blPago`/…) |

Em aberto = status com `aberto|pendente|devedor|não pago|atrasado` (ou flag `pago=false`). A chave natural do débito em `cliente-despesas.json` é **`PED-<id>`**.

## Login por CPF + senha (`POST /bff/login`)

Body confirmado:

```json
{ "cpfCnpj": "07073669500", "senha": "***", "tokenCaptcha": "<reCAPTCHA>", "tokenConcessao": "44", "idUsuario": null }
```

- `cpfCnpj` só dígitos (a tool remove pontuação de `PEDAGIO_DIGITAL_LOGIN`).
- **Sem** header `x-csrf-token` no login; envia só `Origin`/`Referer`/`User-Agent`.
- A resposta traz `Set-Cookie` com a sessão (`bff_sid`, `bff-csrf`, `XSRF-TOKEN`) → vira o `cookie`/`csrf` usados nas chamadas `/bff/api`.

⚠️ **`tokenCaptcha` é reCAPTCHA v2** (site key `6LfNthIrAAAAAIezkzLOg01fWHcyQtk-PjbraHwz`). Pode vir de um token colado em `PEDAGIO_DIGITAL_CAPTCHA`, do **solver automático** (ver abaixo) ou — alternativa — use o override de sessão `COOKIE`+`CSRF`.

## Login gratuito por navegador (Playwright)

Caminho **sem custo** para logar com CPF+senha apesar do reCAPTCHA v2: a tool abre
o **Chrome real** (via `playwright-core`, canal `chrome`) num **perfil persistente**
(`.cache/pedagio-digital/chrome-profile`) e captura a sessão (`bff_sid`+`bff-csrf`)
para `.cache/pedagio-digital/session.json`. Implementação em `browserLogin.ts`.

- **Interativo** (`pedagio-digital login` → `interactiveBrowserLogin`): janela visível,
  preenche CPF+senha (best-effort por seletores) e espera **você** resolver o
  reCAPTCHA + entrar. Faça isto **1 vez**. Detecta o login testando `GET /bff/api/Placa/list` (200) e grava a sessão.
- **Silencioso** (`silentBrowserRefresh`, usado pelos syncs): headless, reabre o
  **mesmo perfil** já logado e, se o SPA reabilitar a sessão sozinho (sem captcha),
  renova o `session.json` **sem intervenção**. Se exigir captcha de novo, devolve
  `null` → rode `pedagio-digital login` outra vez.

Pré-requisitos: `playwright-core` (devDependency) + Chrome instalado. Caminho do
Chrome: `PEDAGIO_DIGITAL_CHROME_PATH` (override) ou padrão
`C:\Program Files\Google\Chrome\Application\chrome.exe`. `ignoreHTTPSErrors` trata
a interceção TLS desta máquina.

> **Quão desatendido fica?** Depende do site: se ele faz silent re-auth no perfil,
> os syncs renovam sozinhos por bastante tempo; quando a renovação exigir captcha,
> é só refazer o `login` interativo (1 clique). É o melhor que dá **de graça** —
> reCAPTCHA existe justamente para impedir login 100% automático sem humano.

## Login automático com solver de reCAPTCHA

Para **automação desatendida** (scheduler), `loginPedagioDigital` resolve o
reCAPTCHA v2 sozinho via um **serviço solver** de terceiros (você cria conta, põe
saldo e gera uma API key). Ordem de obtenção do `tokenCaptcha`:

1. `PEDAGIO_DIGITAL_CAPTCHA` (token manual), se presente;
2. **solver** (`captcha.ts`), se `PEDAGIO_DIGITAL_CAPTCHA_APIKEY` estiver definido;
3. senão, login falha e cai no override de sessão `COOKIE`+`CSRF`.

Variáveis:

| Variável | Valor |
|----------|-------|
| `PEDAGIO_DIGITAL_CAPTCHA_PROVIDER` | `capsolver` (default) \| `2captcha` \| `anticaptcha` |
| `PEDAGIO_DIGITAL_CAPTCHA_APIKEY` | API key do serviço |
| `PEDAGIO_DIGITAL_CAPTCHA_SITEKEY` | opcional (default: site key acima) |
| `PEDAGIO_DIGITAL_CAPTCHA_TIMEOUT_MS` | opcional (default `120000`) |

Fluxo do solver (todos com o padrão *createTask → poll getTaskResult*):

- **CapSolver** — `POST https://api.capsolver.com/createTask` task `ReCaptchaV2TaskProxyLess` (`websiteURL`, `websiteKey`) → poll `/getTaskResult` até `status: "ready"` → `solution.gRecaptchaResponse`.
- **Anti-Captcha** — `POST https://api.anti-captcha.com/createTask` task `RecaptchaV2TaskProxyless` → `/getTaskResult` → `solution.gRecaptchaResponse`.
- **2Captcha** — `POST https://api.2captcha.com/createTask` (API nova, compatível) task `RecaptchaV2TaskProxyless` → `/getTaskResult`.

O `gRecaptchaResponse` devolvido é exatamente o `tokenCaptcha` que `POST /bff/login` espera.

```powershell
[Environment]::SetEnvironmentVariable("PEDAGIO_DIGITAL_LOGIN", "<cpf>", "User")
[Environment]::SetEnvironmentVariable("PEDAGIO_DIGITAL_SENHA", "<senha>", "User")
[Environment]::SetEnvironmentVariable("PEDAGIO_DIGITAL_CAPTCHA_PROVIDER", "capsolver", "User")
[Environment]::SetEnvironmentVariable("PEDAGIO_DIGITAL_CAPTCHA_APIKEY", "<api key do solver>", "User")
# feche e reabra o terminal/Cursor para aplicar
```

> **Custo/ToS:** o solver é pago (centavos por resolução) e resolver captcha de
> forma automatizada é zona cinzenta de ToS — use apenas na **sua própria** conta.

## Override / debug (capturar sessão no DevTools)

1. [pedagiodigital.com](https://pedagiodigital.com) logado.
2. DevTools → Network → qualquer pedido `/bff/api/...`.
3. Copiar o header **`cookie`** inteiro → `PEDAGIO_DIGITAL_COOKIE`.
4. Num pedido **POST** (ex.: `register`), copiar **`x-csrf-token`** → `PEDAGIO_DIGITAL_CSRF`.

Estes têm prioridade sobre o login por credenciais.

**Offline (recomendado quando a sessão expira):** salve a resposta de
`/Passagem/list-logado` (DevTools → Response → Save as) e processe sem API:
- `sync-pedagios --json arquivo.json` → toda a frota ativa (agrupa por placa).
- `sync-pedagios --json arquivo.json --placa PLACA` → só uma placa.
