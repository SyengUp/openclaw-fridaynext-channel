# Friday Next installer bootstrap (Windows).
#
# Mirror of install.sh for native Windows (no `sh` there): probe the official npm
# registry and npmmirror, then run npx from the faster one. The package's own
# install.js does the real work and is already cross-platform.
#
# Usage (PowerShell):
#   iwr -useb https://gw.syengup.host/v1/friday-next/install.ps1 | iex
#   iex "& { $(iwr -useb https://gw.syengup.host/v1/friday-next/install.ps1) } -Beta"
# (`iex`-piped scripts cannot take arguments, so the beta form wraps it in a
# scriptblock. $env:FRIDAY_CHANNEL_NEXT_CHANNEL = "beta" works too.)
#
# After the QR prints, an interactive console waits for a key so a double-clicked
# PowerShell window (or `powershell -File`) does not vanish before they can scan.
# SSH / redirected stdin / FRIDAY_INSTALL_NO_PAUSE skip the wait. Do not `exit`
# after `iwr | iex` — that would close the user's session.
param([switch]$Beta)

$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 defaults to TLS 1.0 for Invoke-WebRequest; both registries
# require 1.2+.
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {}

# Non-interactive shells (SSH, scheduled tasks) often miss the user npm shim dir that
# `openclaw.cmd` and `npx.cmd` live in. Prepend the two default Node installer locations
# before probing — a missing PATH is the usual "npx/openclaw not found" on native Windows.
foreach ($dir in @((Join-Path $env:APPDATA "npm"), (Join-Path $env:ProgramFiles "nodejs"))) {
  if ($dir -and (Test-Path $dir)) { $env:Path = "$dir;" + $env:Path }
}

$PKG = "@syengup/friday-channel-next"
$OfficialUrl = "https://registry.npmjs.org"
$MirrorUrl = "https://registry.npmmirror.com"
$PROBE_TIMEOUT = 3

if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
  Write-Error "friday-next: npx not found — install Node.js first"
  exit 1
}

# Seconds to probe a registry's /-/ping, or $null when unreachable. Sequential on
# purpose: Start-Job parallelism is not worth the PS 5.1 compat risk for ≤6s.
function Test-Registry([string]$Url) {
  try {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    Invoke-WebRequest -Uri "$Url/-/ping" -UseBasicParsing -TimeoutSec $PROBE_TIMEOUT | Out-Null
    $sw.Stop()
    return $sw.Elapsed.TotalSeconds
  } catch {
    return $null
  }
}

if ($env:FRIDAY_NPM_REGISTRY) {
  $registry = $env:FRIDAY_NPM_REGISTRY
} else {
  # Names must not collide with $OfficialUrl / $MirrorUrl — PowerShell variables
  # are case-insensitive, so `$official = …` would clobber `$OfficialUrl`.
  $officialMs = Test-Registry $OfficialUrl
  $mirrorMs = Test-Registry $MirrorUrl

  # Both unreachable → npmmirror. Typical China failure is official-dead /
  # mirror-fine; preferring official there would recreate the npx hang.
  if ($null -eq $officialMs -and $null -eq $mirrorMs) { $registry = $MirrorUrl }
  elseif ($null -eq $officialMs) { $registry = $MirrorUrl }
  elseif ($null -eq $mirrorMs) { $registry = $OfficialUrl }
  elseif ($mirrorMs + 0.150 -ge $officialMs) { $registry = $OfficialUrl } # close race: official
  else { $registry = $MirrorUrl }
}

$env:npm_config_registry = $registry
Write-Host "friday-next: using $registry" -ForegroundColor DarkGray

# install.js also honors FRIDAY_CHANNEL_NEXT_CHANNEL=beta; forward the switch both ways
# (dist-tag spec pins the installer itself, --beta pins the payload it installs).
$betaRequested = $Beta -or $env:FRIDAY_CHANNEL_NEXT_CHANNEL -eq "beta"
$spec = if ($betaRequested) { "$PKG@beta" } else { $PKG }
$npxArgs = @("-y", $spec)
if ($betaRequested) { $npxArgs += "--beta" }

& npx @npxArgs
$installExit = $LASTEXITCODE

# `iwr | iex` runs this script *inside* the user's PowerShell session. `exit` would
# kill that session — and a `powershell -Command` window would vanish with the QR.
# Keep the window up so they can scan; skip when stdin isn't a console (CI / SSH).
$shouldPause = -not $env:FRIDAY_INSTALL_NO_PAUSE
if ($shouldPause) {
  try { if ([Console]::IsInputRedirected) { $shouldPause = $false } } catch {}
}
if ($shouldPause -and ($env:SSH_CLIENT -or $env:SSH_CONNECTION)) { $shouldPause = $false }
if ($shouldPause -and $Host.Name -eq "ConsoleHost") {
  $zh = ($PSUICulture -like "zh*") -or ($env:FRIDAY_INSTALL_LANG -like "zh*")
  Write-Host ""
  if ($zh) { Write-Host "扫完码后按任意键关闭" -ForegroundColor DarkGray }
  else { Write-Host "Press any key after scanning" -ForegroundColor DarkGray }
  try { $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown") }
  catch { Read-Host " " | Out-Null }
}

# Don't `exit` — that closes an iex'd session. -File callers still get this as the
# script's result; interactive hosts just return to the prompt.
if ($MyInvocation.InvocationName -eq "." -or $MyInvocation.Line -match "iex") {
  # stay in the caller's session
} elseif ($installExit -ne 0) {
  exit $installExit
}
