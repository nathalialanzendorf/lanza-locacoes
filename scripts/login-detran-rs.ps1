# Login assistido no DETRAN RS via gov.br: abre o navegador, faz o login e grava
# o token e o X-User-Id nas variaveis de ambiente do utilizador
# (DETRAN_RS_AUTH / DETRAN_RS_USER_ID).
#
# Dois modos de login (gratuitos):
#   A) CERTIFICADO DIGITAL A1 (recomendado — sem senha nem captcha):
#        # 1a vez (guarda caminho+senha do .pfx):
#        .\scripts\login-detran-rs.ps1 -Pfx "C:\caminho\certificado.pfx" -PfxPass "<senha-pfx>"
#        # rede com interceção TLS (usa o certificado do Windows, sem proxy do Playwright):
#        .\scripts\login-detran-rs.ps1 -OsCert
#   B) CPF + SENHA (fallback — voce resolve o reCAPTCHA/2FA):
#        .\scripts\login-detran-rs.ps1 -Cpf "<cpf>" -Senha "<senha>"
#   C) MANUAL (faz tudo a mao no gov.br):
#        .\scripts\login-detran-rs.ps1 -Manual
#
#   Depois (reaproveita o que ja foi guardado):
#        .\scripts\login-detran-rs.ps1
#
# As credenciais NAO vao para `.env` nem para o Git — so para variaveis do utilizador.

param(
  [string]$Pfx,
  [string]$PfxPass,
  [switch]$OsCert,
  [string]$Cpf,
  [string]$Senha,
  [switch]$Manual
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot

# Certificado A1 (caminho + senha do .pfx).
if ($Pfx) {
  $p = $Pfx.Trim()
  if (-not (Test-Path $p)) { Write-Error "Arquivo .pfx nao encontrado: $p"; exit 1 }
  [Environment]::SetEnvironmentVariable("DETRAN_RS_PFX_PATH", $p, "User")
  $env:DETRAN_RS_PFX_PATH = $p
}
if ($PfxPass) {
  [Environment]::SetEnvironmentVariable("DETRAN_RS_PFX_PASS", $PfxPass, "User")
  $env:DETRAN_RS_PFX_PASS = $PfxPass
}

# Fallback CPF/senha do gov.br.
if ($Cpf) {
  $c = $Cpf.Trim()
  [Environment]::SetEnvironmentVariable("DETRAN_RS_GOV_CPF", $c, "User")
  $env:DETRAN_RS_GOV_CPF = $c
}
if ($Senha) {
  [Environment]::SetEnvironmentVariable("DETRAN_RS_GOV_SENHA", $Senha.Trim(), "User")
  $env:DETRAN_RS_GOV_SENHA = $Senha.Trim()
}

# Sem -Pfx, sem -Cpf/-Senha e sem -Manual, o padrao e o CERTIFICADO DIGITAL do
# Windows: o Chrome pede para selecionar o certificado (e o PIN, se for token A3).
$temPfx = $env:DETRAN_RS_PFX_PATH -or $env:DETRAN_PFX_PATH
$temCpf = $env:DETRAN_RS_GOV_CPF -and $env:DETRAN_RS_GOV_SENHA
if (-not $Manual -and -not $temPfx -and -not $temCpf -and -not $OsCert) {
  Write-Host "Sem .pfx/CPF configurados: usando o CERTIFICADO DIGITAL instalado no Windows."
  Write-Host "Selecione o certificado quando o Chrome pedir (gratuito, sem captcha)."
  $scriptUsaOsCert = $true
} else {
  $scriptUsaOsCert = $false
}

$captureFile = Join-Path ([System.IO.Path]::GetTempPath()) "detran_rs_capture.json"
if (Test-Path $captureFile) { Remove-Item $captureFile -Force }

$scriptArgs = @("tsx", "scripts/capturarDetranRsToken.ts")
if ($OsCert -or $scriptUsaOsCert) { $scriptArgs += "--os-cert" }
if ($Manual) { $scriptArgs += "--manual" }

Push-Location $repoRoot
try {
  & npx @scriptArgs
} finally {
  Pop-Location
}

if (-not (Test-Path $captureFile)) {
  Write-Error "Captura nao gerou token (ficheiro ausente). O login gov.br foi concluido?"
  exit 1
}

$data = Get-Content $captureFile -Raw | ConvertFrom-Json
Remove-Item $captureFile -Force

if (-not $data.auth -or -not $data.userId) {
  Write-Error "Captura incompleta (auth/userId em falta). Repita o login gov.br ate o portal carregar a frota."
  exit 1
}

[Environment]::SetEnvironmentVariable("DETRAN_RS_AUTH", [string]$data.auth, "User")
[Environment]::SetEnvironmentVariable("DETRAN_RS_USER_ID", [string]$data.userId, "User")
$env:DETRAN_RS_AUTH = [string]$data.auth
$env:DETRAN_RS_USER_ID = [string]$data.userId

Write-Host "OK: DETRAN_RS_AUTH e DETRAN_RS_USER_ID gravados nas variaveis de ambiente do utilizador."
Write-Host "    Token valido por algumas horas; ao expirar (HTTP 401), rode este script de novo."
Write-Host "    Feche e reabra os terminais (ou o Cursor) para os outros processos verem os novos valores."
