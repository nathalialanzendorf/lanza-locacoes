# Wrapper da CLI Lanza — usa tsx local (mais rápido e estável que npx no Windows/Dropbox).
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot
$tsx = Join-Path $repoRoot 'node_modules\.bin\tsx.cmd'
if (-not (Test-Path $tsx)) {
  Write-Error 'tsx não instalado. Na raiz do repo: npm install'
}
& $tsx src/run.ts @args
exit $LASTEXITCODE
