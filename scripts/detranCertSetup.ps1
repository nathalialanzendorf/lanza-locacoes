# Setup GRATUITO para login automatico com certificado digital A1 no DETRAN SC
# (via gov.br), usado pelo solver (scripts/detranSolver.ts).
#
# Faz duas coisas, idempotentes e reversiveis:
#   1. Importa o .pfx (A1) em Cert:\CurrentUser\My  -> NAO precisa de admin.
#   2. Define a politica do Chrome AutoSelectCertificateForUrls para os hosts do
#      gov.br, para o Chrome apresentar o certificado AUTOMATICAMENTE (sem o
#      dialogo nativo). A subarvore ...\SOFTWARE\Policies e' protegida por ACL,
#      entao a politica e' gravada em HKLM com auto-elevacao (UAC) quando preciso.
#
# Uso:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/detranCertSetup.ps1
#   (le DETRAN_PFX_PATH / DETRAN_PFX_PASS do ambiente, ou passe -PfxPath/-PfxPass)
#
# Desfazer a politica (admin):
#   Remove-Item "HKLM:\SOFTWARE\Policies\Google\Chrome\AutoSelectCertificateForUrls" -Recurse

param(
  [string]$PfxPath = $env:DETRAN_PFX_PATH,
  [string]$PfxPass = $env:DETRAN_PFX_PASS,
  # CN do emissor para refinar a auto-selecao (opcional). Vazio = qualquer cert.
  [string]$IssuerCN = $env:DETRAN_CERT_ISSUER_CN,
  # Interno: reexecucao elevada que apenas grava a politica em HKLM.
  [switch]$PolicyOnly
)

$ErrorActionPreference = "Stop"

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$id).IsInRole(
    [Security.Principal.WindowsBuiltinRole]::Administrator)
}

function Set-ChromePolicy {
  param([string]$Root, [string]$Issuer)
  $key = "$Root\SOFTWARE\Policies\Google\Chrome\AutoSelectCertificateForUrls"
  New-Item -Path $key -Force | Out-Null
  foreach ($p in (Get-Item -Path $key).Property) {
    Remove-ItemProperty -Path $key -Name $p -ErrorAction SilentlyContinue
  }
  $urls = @(
    "https://certificado.sso.acesso.gov.br",
    "https://sso.acesso.gov.br",
    "https://[*.]acesso.gov.br"
  )
  $i = 1
  foreach ($u in $urls) {
    if ($Issuer) {
      $obj = @{ pattern = $u; filter = @{ ISSUER = @{ CN = $Issuer } } }
    }
    else {
      $obj = @{ pattern = $u; filter = @{} }
    }
    $json = $obj | ConvertTo-Json -Compress -Depth 5
    New-ItemProperty -Path $key -Name "$i" -Value $json -PropertyType String -Force | Out-Null
    $i++
  }
  Write-Host ("POLICY_SET {0} urls={1}" -f $Root, $urls.Count)
}

# --- Reexecucao elevada: so grava a politica em HKLM e sai. ---
if ($PolicyOnly) {
  Set-ChromePolicy -Root "HKLM:" -Issuer $IssuerCN
  Write-Host "SETUP_OK"
  exit 0
}

# --- 1) Importar o A1 em Cert:\CurrentUser\My (idempotente, sem admin) ---
if ($PfxPath -and (Test-Path $PfxPath)) {
  try {
    $col = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection
    $col.Import(
      $PfxPath,
      $PfxPass,
      [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::PersistKeySet
    )
    $sec = ConvertTo-SecureString -String $PfxPass -AsPlainText -Force
    foreach ($c in $col) {
      if (-not $c.HasPrivateKey) { continue }
      $existe = Get-ChildItem Cert:\CurrentUser\My -ErrorAction SilentlyContinue |
        Where-Object { $_.Thumbprint -eq $c.Thumbprint }
      if ($existe) {
        Write-Host ("CERT_PRESENT thumb={0} subj={1}" -f $c.Thumbprint.Substring(0, 8), $c.Subject)
      }
      else {
        Import-PfxCertificate -FilePath $PfxPath -CertStoreLocation Cert:\CurrentUser\My -Password $sec |
          Out-Null
        Write-Host ("CERT_IMPORTED thumb={0} subj={1}" -f $c.Thumbprint.Substring(0, 8), $c.Subject)
      }
    }
  }
  catch {
    Write-Host ("CERT_IMPORT_FAIL {0}" -f $_.Exception.Message)
  }
}
else {
  Write-Host "PFX_NOT_SET (defina DETRAN_PFX_PATH e DETRAN_PFX_PASS) - usarei os certificados ja presentes no Windows."
}

# --- 2) Politica do Chrome (HKLM; auto-eleva se necessario) ---
$jaConfigurada = $false
try {
  $k = "HKLM:\SOFTWARE\Policies\Google\Chrome\AutoSelectCertificateForUrls"
  if (Test-Path $k) {
    $props = (Get-Item -Path $k).Property
    foreach ($p in $props) {
      if ((Get-ItemProperty -Path $k -Name $p).$p -match "acesso\.gov\.br") { $jaConfigurada = $true; break }
    }
  }
}
catch { $jaConfigurada = $false }

if ($jaConfigurada -and -not $IssuerCN) {
  Write-Host "POLICY_ALREADY_SET HKLM (sem UAC)"
}
elseif (Test-Admin) {
  Set-ChromePolicy -Root "HKLM:" -Issuer $IssuerCN
}
else {
  $script = $MyInvocation.MyCommand.Path
  $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $script, "-PolicyOnly")
  if ($IssuerCN) { $argList += @("-IssuerCN", $IssuerCN) }
  Write-Host "POLICY_ELEVATE pedindo UAC para gravar a politica do Chrome em HKLM..."
  try {
    $p = Start-Process -FilePath "powershell" -ArgumentList $argList -Verb RunAs -Wait -PassThru
    if ($p.ExitCode -eq 0) {
      Write-Host "POLICY_SET HKLM (elevado)"
    }
    else {
      Write-Host ("POLICY_FAIL exit={0}" -f $p.ExitCode)
    }
  }
  catch {
    Write-Host ("POLICY_SKIP elevacao cancelada/indisponivel: {0}" -f $_.Exception.Message)
    Write-Host "Sem a politica, o login pedira o clique no certificado UMA vez (o resto segue automatico)."
  }
}

Write-Host "SETUP_OK"
