# Grava as credenciais do pedagiodigital.com nas variáveis de ambiente
# persistentes do utilizador (Windows). Não use `.env` para credenciais.
#
# Uso (PowerShell):
#   .\scripts\set-pedagio-digital-user-env.ps1 -Login "<cpf>" -Senha "<senha>"
#
# Depois: feche e reabra terminais (ou reinicie o Cursor).

param(
  [Parameter(Mandatory = $true)]
  [string]$Login,
  [Parameter(Mandatory = $true)]
  [string]$Senha
)

$ErrorActionPreference = "Stop"
if (-not $Login.Trim() -or -not $Senha.Trim()) {
  Write-Error "Login/Senha vazios."
  exit 1
}

[Environment]::SetEnvironmentVariable("PEDAGIO_DIGITAL_LOGIN", $Login.Trim(), "User")
[Environment]::SetEnvironmentVariable("PEDAGIO_DIGITAL_SENHA", $Senha.Trim(), "User")
Write-Host "OK: PEDAGIO_DIGITAL_LOGIN e PEDAGIO_DIGITAL_SENHA gravados nas variaveis de ambiente do utilizador."
Write-Host "    Feche e reabra os terminais (ou o Cursor) para aplicar."
