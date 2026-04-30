#!/usr/bin/env pwsh
#Requires -Version 5.1
# Mintlayer Web GUI — Windows installer
# Usage: irm https://get.mintlayer.org/windows.ps1 | iex

[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ── Execution policy check ────────────────────────────────────────────────────
if (-not [string]::IsNullOrEmpty($PSCommandPath)) {
    $policy = Get-ExecutionPolicy -Scope CurrentUser
    if ($policy -eq 'Restricted') {
        Write-Host "ExecutionPolicy is Restricted. Run this first:" -ForegroundColor Yellow
        Write-Host "  Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned" -ForegroundColor Cyan
        Write-Host "Then re-run the script." -ForegroundColor Gray
        Exit-ML 1
    }
}

# ── Interactive check ─────────────────────────────────────────────────────────
if (-not [Environment]::UserInteractive) {
    Write-Error "This script requires an interactive terminal."
    Exit-ML 1
}

# ── Admin detection ───────────────────────────────────────────────────────────
$script:IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)

# ── .NET SHA512 availability check ───────────────────────────────────────────
$script:Sha512Available = $true
try { $null = [System.Security.Cryptography.HashAlgorithmName]::SHA512 }
catch { $script:Sha512Available = $false }

# ── Colors ────────────────────────────────────────────────────────────────────
$script:UseAnsi = $PSVersionTable.PSVersion.Major -ge 7 -or
                  $env:WT_SESSION -or $env:TERM_PROGRAM -or $env:TERM

if ($script:UseAnsi) {
    $RESET  = "`e[0m";  $BOLD = "`e[1m";  $DIM  = "`e[2m"
    $CYAN   = "`e[36m"; $GREEN = "`e[32m"; $YELLOW = "`e[33m"
    $RED    = "`e[31m"; $GRAY  = "`e[90m"
} else {
    $RESET = $BOLD = $DIM = $CYAN = $GREEN = $YELLOW = $RED = $GRAY = ''
}

# ── UI helpers ────────────────────────────────────────────────────────────────
function Step-ML  { Write-Host "`n${CYAN}◆${RESET} ${BOLD}$($args -join ' ')${RESET}" }
function Ask-ML   { Write-Host "${CYAN}◇${RESET} ${BOLD}$($args -join ' ')${RESET}" }
function Hint-ML  { Write-Host "${GRAY}│  $($args -join ' ')${RESET}" }
function Ok-ML    { Write-Host "${GREEN}◈${RESET} $($args -join ' ')" }
function Warn-ML  { Write-Host "${YELLOW}▲${RESET}  $($args -join ' ')" }
function Err-ML   { Write-Host "${RED}✗${RESET}  $($args -join ' ')" }
function Divider-ML { Write-Host "${GRAY}└─────────────────────────────────────────${RESET}" }

function Exit-ML([int]$Code = 0) {
    Write-Host ""
    Read-Host "Press Enter to close"
    exit $Code
}

function Prompt-ML([string]$Question, [string]$Default = '') {
    if ($Default) { Write-Host "${CYAN}│${RESET}  $Question ${GRAY}($Default)${RESET} " -NoNewline }
    else          { Write-Host "${CYAN}│${RESET}  $Question " -NoNewline }
    $val = Read-Host
    if ([string]::IsNullOrEmpty($val) -and $Default) { return $Default }
    return $val
}

function PromptSecret-ML([string]$Question) {
    Write-Host "${CYAN}│${RESET}  $Question " -NoNewline
    $ss  = Read-Host -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)
    try   { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Choose-ML([string]$Question, [string[]]$Options) {
    Write-Host "${CYAN}│${RESET}"
    Write-Host "${CYAN}│${RESET}  $Question"
    for ($i = 0; $i -lt $Options.Length; $i++) {
        Write-Host "${CYAN}│${RESET}    ${GRAY}$($i+1))${RESET} $($Options[$i])"
    }
    while ($true) {
        Write-Host "${CYAN}│${RESET}  ${GRAY}›${RESET} " -NoNewline
        $c = Read-Host
        if ($c -match '^\d+$' -and [int]$c -ge 1 -and [int]$c -le $Options.Length) {
            return $Options[[int]$c - 1]
        }
        Write-Host "${CYAN}│${RESET}  ${RED}Please enter a number between 1 and $($Options.Length)${RESET}"
    }
}

function Confirm-ML([string]$Question, [string]$Default = 'Y') {
    $hint = if ($Default -eq 'Y') { 'Y/n' } else { 'y/N' }
    Write-Host "${CYAN}│${RESET}  $Question ${GRAY}[$hint]${RESET} " -NoNewline
    $val = Read-Host
    if ([string]::IsNullOrEmpty($val)) { $val = $Default }
    if ($val -match '^[Yy]') { return 'yes' }
    return 'no'
}

# ── Crypto helpers ────────────────────────────────────────────────────────────
function New-RandomPassword([int]$Length = 32) {
    $rng     = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.ToCharArray()
    $bias    = 256 - (256 % $charset.Length)
    $result  = [System.Text.StringBuilder]::new()
    $buf     = New-Object byte[] 1
    while ($result.Length -lt $Length) {
        $rng.GetBytes($buf)
        if ($buf[0] -lt $bias) { [void]$result.Append($charset[$buf[0] % $charset.Length]) }
    }
    return $result.ToString()
}

function New-PasswordHash([string]$Password) {
    $rng  = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $salt = New-Object byte[] 32
    $rng.GetBytes($salt)
    $saltHex = ([BitConverter]::ToString($salt) -replace '-').ToLower()
    $pbkdf2  = New-Object System.Security.Cryptography.Rfc2898DeriveBytes(
        $Password, $salt, 100000,
        [System.Security.Cryptography.HashAlgorithmName]::SHA512)
    $key    = $pbkdf2.GetBytes(64)
    $pbkdf2.Dispose()
    $keyHex = ([BitConverter]::ToString($key) -replace '-').ToLower()
    return "pbkdf2:sha512:100000:${saltHex}:${keyHex}"
}

function ConvertTo-Base32([byte[]]$Bytes) {
    $alpha   = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    $result  = [System.Text.StringBuilder]::new()
    $buf = 0; $bitsLeft = 0
    foreach ($b in $Bytes) {
        $buf = ($buf -shl 8) -bor $b; $bitsLeft += 8
        while ($bitsLeft -ge 5) {
            $bitsLeft -= 5
            [void]$result.Append($alpha[($buf -shr $bitsLeft) -band 0x1F])
        }
    }
    if ($bitsLeft -gt 0) { [void]$result.Append($alpha[($buf -shl (5 - $bitsLeft)) -band 0x1F]) }
    return $result.ToString()
}

function New-TotpSecret {
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $b   = New-Object byte[] 20; $rng.GetBytes($b)
    return ConvertTo-Base32 -Bytes $b
}

function New-SessionSecret {
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $b   = New-Object byte[] 32; $rng.GetBytes($b)
    return ([BitConverter]::ToString($b) -replace '-').ToLower()
}

function ConvertTo-DockerPath([string]$p) {
    $p = $p -replace '\\', '/'
    if ($p -match '^([A-Za-z]):(.*)') { return '/' + $Matches[1].ToLower() + $Matches[2] }
    return $p
}

function Write-Utf8([string]$Path, [string]$Content) {
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

# ── Favicon (embedded) ────────────────────────────────────────────────────────
$script:FaviconBase64 = 'AAABAAEAICAAAAEAIACoEAAAFgAAACgAAAAgAAAAQAAAAAEAIAAAAAAAABAAABMLAAATCwAAAAAAAAAAAACL2jePjts1PwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACH1zggjNo2n4zbN/+M2zf/jNs3v47bN08AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACO2zk/jNo2n4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbNu+N2zZ/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACK2jVgi9o334zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M3jofAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIzbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zeOh8AAAAAi9s4QIzaN8+M3TVvf89AEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAjNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jN42HwAAAACL2zhAjNs3/4zbN/+M2zbvi9o3j43ZNi8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACM2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M3jofAAAAAIvbOECM2zf/jNs3/4zbN/+M2zf/jNs3/4zcNp8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIzbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zeOh8AAAAAi9s4QIzbN/+M2zf/jNs3/4zbN/+M2zf/jNs3vwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAjNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jN42HwAAAACL2zhAjNs3/4zbN/+M2zf/jNs3/4zbN/+M2ze/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACM2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M3jofAAAAAIvbOECM2zf/jNs3/4zbN/+M2zf/jNs3/4zbN78AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIzbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zeOh8AAAAAi9s4QIzbN/+M2zf/jNs3/4zbN/+M2zf/jNs3vwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAjNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jN42HwAAAACL2zhAjNs3/4zbN/+M2zf/jNs3/4zbN/+M2ze/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACM2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M3jofAAAAAIvbOECM2zf/jNs3/4zbN/+M2zf/jNs3/4zbN78AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIzbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zeOh8AAAAAi9s4QIzbN/+M2zf/jNs3/4zbN/+M2zf/jNs3vwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIfXOCCM2jafjN01bwAAAAAAAAAAjNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jN42HwAAAACL2zhAjNs3/4zbN/+M2zf/jNs3/4zbN/+M2ze/AAAAAAAAAAAAAAAAAAAAAIraNWCM2ze/jNs3/4zbN/+N2zZ/AAAAAAAAAACM2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M3jofAAAAAIvbOECM2zf/jNs3/4zbN/+M2zf/jNs3/4zbN78AAAAAAAAAAIzcNlCL2jffjNs3/4zbN/+M2zf/jNs3/43bNn8AAAAAAAAAAIzbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zeOh8AAAAAi9s4QIzbN/+M2zf/jNs3/4zbN/+M2zf/i9s1jwAAAAAAAAAAjdw2n4zbN/+M2zf/jNs3/4zbN/+M2zf/jds2fwAAAAAAAAAAjNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jN42HwAAAACL2zhAjNs3/4zbN/+M2zf/jdw2n4/fOCAAAAAAAAAAAAAAAAAAAAAAAAAAAI3cNp+M2zf/jNs3/4zbN/+M2zf/jNs3/43bNn8AAAAAAAAAAIzbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zeOh8AAAAAi9s4QI3cN9+O3DhfjN82HwAAAAAAAAAAAAAAAAAAAAAAAAAAAI3cNp+M2zf/jNs3/4zbN/+M2zf/jNs3/43bNn8AAAAAAAAAAIzbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zeOh8AAAAAj99AEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAjdw2n4zbN/+M2zf/jNs3/4zbN/+M2zf/jds2fwAAAAAAAAAAjNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jN42HwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACN3DafjNs3/4zbN/+M2zf/jNs3/4zbN/+N2zZ/AAAAAAAAAACM2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M3jofAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI3cNp+M2zf/jNs3/4zbN/+M2zf/jNs3/43bNn8AAAAAAAAAAIzbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zeOh8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAjdw2n4zbN/+M2zf/jNs3/4zbN/+M2zf/jds2fwAAAAAAAAAAjNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jN42HwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACN3DafjNs3/4zbN/+M2zf/jNs3/4zbN/+N2zZ/AAAAAAAAAACM2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M3jofAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI3cNp+M2zf/jNs3/4zbN/+M2zf/jNs3/43bNn8AAAAAAAAAAIzbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zeOh8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAj9s4f4zbN/+M2zf/jNs3/4zbN/+M2zf/jds2fwAAAAAAAAAAjNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jN42HwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAi9s4QIzcNq+M2zf/jNs3/4zbN/+N2zZ/AAAAAAAAAACM2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M3jofAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI/fQBCL2ziAjdw2743bNn8AAAAAAAAAAIzbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zeOh8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAj984IAAAAAAAAAAAjNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/4zbN/+N3Dafj89AEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACN2zePjdw274zbN/+M2zf/jNs3/4zbN/+M2zf/jNs3/43cN9+N3Dafj984IAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACP30AQi9s4gI3cN9+M2zf/jNs3/4zaN8+O3DhfAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIvbOECM2ze/P////A////AD///AAf//wAEP/8ABA//AAQH/wAEB/8ABAf/AAQH/wAEB/8ABAf/AAQH/wAEB+MABAeDAAQGAwAEBgMABA4DAAQ+AwAF/gMAB/4DAAf+AwAH/gMAB/4DAAf+AwAH/gMAB/8DAAf/wwAH//sAB///AB///4D////w='

# ── Docker helpers ────────────────────────────────────────────────────────────
function Test-DockerRunning {
    $out = docker info 2>&1
    return $LASTEXITCODE -eq 0
}

function Get-ComposeCmd {
    docker compose version 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { return 'docker compose' }
    if (Get-Command docker-compose -ErrorAction SilentlyContinue) { return 'docker-compose' }
    Err-ML "Docker Compose is not available."
    Exit-ML 1
}

# ── check_prereqs ─────────────────────────────────────────────────────────────
function Invoke-CheckPrereqs {
    if (-not $script:Sha512Available) {
        Err-ML ".NET 4.7.2 or later is required for password hashing."
        Write-Host "  Download: https://dotnet.microsoft.com/download/dotnet-framework" -ForegroundColor Cyan
        Exit-ML 1
    }

    $dockerInstalled = (Get-ItemProperty 'HKLM:\SOFTWARE\Docker Inc.\Docker Desktop' `
        -Name Version -ErrorAction SilentlyContinue) -or
        (Get-Command docker -ErrorAction SilentlyContinue)

    if (-not $dockerInstalled) {
        Warn-ML "Docker Desktop is not installed."
        Write-Host "${CYAN}│${RESET}"
        $winget = Get-Command winget -ErrorAction SilentlyContinue
        if ($winget) {
            $install = Confirm-ML "Install Docker Desktop automatically via winget?" 'Y'
            if ($install -eq 'yes') {
                Step-ML "Installing Docker Desktop"
                winget install --id Docker.DockerDesktop --accept-source-agreements --accept-package-agreements
                Write-Host ""
                Warn-ML "Docker Desktop installed. Please:"
                Hint-ML "1. Launch Docker Desktop from the Start Menu"
                Hint-ML "2. Complete the first-run setup wizard"
                Hint-ML "3. Wait for the whale icon in the system tray"
                Hint-ML "4. Re-run this script"
                Exit-ML 0
            }
        }
        Err-ML "Docker Desktop is required."
        Write-Host "  Download: https://docs.docker.com/desktop/install/windows-install/" -ForegroundColor Cyan
        Exit-ML 1
    }

    if (-not (Test-DockerRunning)) {
        Err-ML "Docker Desktop is installed but not running."
        Write-Host "  Start Docker Desktop from the Start Menu, wait for it to finish loading," -ForegroundColor Yellow
        Write-Host "  then re-run this script." -ForegroundColor Yellow
        Exit-ML 1
    }

    docker compose version 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0 -and -not (Get-Command docker-compose -ErrorAction SilentlyContinue)) {
        Err-ML "Docker Compose is not available."
        Write-Host "  Reinstall Docker Desktop from https://docs.docker.com/desktop/install/windows-install/" -ForegroundColor Gray
        Exit-ML 1
    }
}

# ── bootstrap_remote ──────────────────────────────────────────────────────────
function Invoke-Bootstrap {
    Write-Host ""
    Write-Host "${CYAN}◆${RESET} ${BOLD}Install location${RESET}"
    Write-Host "${GRAY}│  Where should Mintlayer Web GUI be installed?${RESET}"
    $default = Join-Path $env:USERPROFILE 'mintlayer'
    Write-Host "${CYAN}│${RESET}  Directory: ${GRAY}($default)${RESET} " -NoNewline
    $val = Read-Host
    $script:InstallDir = if ([string]::IsNullOrEmpty($val)) { $default } else { $val }

    New-Item -ItemType Directory -Force -Path $script:InstallDir | Out-Null
    Set-Location $script:InstallDir

    $composePath = Join-Path $script:InstallDir 'docker-compose.yml'
    if (Test-Path $composePath) {
        Ok-ML "docker-compose.yml already exists — skipping"
    } else {
        # Single-quoted here-string: PowerShell does NOT expand $ signs inside @'...'@
        $compose = @'
x-common: &common
  volumes:
    - "./mintlayer-data:/home/mintlayer"
  restart: unless-stopped

x-common-env: &common-env
  ML_USER_ID: "${ML_USER_ID:-1000}"
  ML_GROUP_ID: "${ML_GROUP_ID:-1000}"

x-node-rpc-env: &node-rpc-env
  ML_MAINNET_NODE_RPC_USERNAME: "${NODE_RPC_USERNAME}"
  ML_MAINNET_NODE_RPC_PASSWORD: "${NODE_RPC_PASSWORD}"
  ML_TESTNET_NODE_RPC_USERNAME: "${NODE_RPC_USERNAME}"
  ML_TESTNET_NODE_RPC_PASSWORD: "${NODE_RPC_PASSWORD}"

services:
  node-daemon:
    <<: *common
    image: "mintlayer/node-daemon:latest"
    command: "node-daemon ${NETWORK:-mainnet}"
    labels:
      com.centurylinklabs.watchtower.enable: "true"
    environment:
      <<: [*common-env, *node-rpc-env]
      RUST_LOG: "${RUST_LOG:-info}"
      ML_MAINNET_NODE_RPC_BIND_ADDRESS: "0.0.0.0:3030"
      ML_TESTNET_NODE_RPC_BIND_ADDRESS: "0.0.0.0:3030"

  wallet-rpc-daemon:
    <<: *common
    image: "mintlayer/wallet-rpc-daemon:latest"
    command: "${WALLET_RPC_CMD:-wallet-rpc-daemon mainnet}"
    labels:
      com.centurylinklabs.watchtower.enable: "true"
    depends_on:
      - node-daemon
    environment:
      <<: *common-env
      RUST_LOG: "${RUST_LOG:-info}"
      ML_MAINNET_WALLET_RPC_DAEMON_NODE_RPC_ADDRESS: "node-daemon:3030"
      ML_MAINNET_WALLET_RPC_DAEMON_NODE_RPC_USERNAME: "${NODE_RPC_USERNAME}"
      ML_MAINNET_WALLET_RPC_DAEMON_NODE_RPC_PASSWORD: "${NODE_RPC_PASSWORD}"
      ML_MAINNET_WALLET_RPC_DAEMON_RPC_BIND_ADDRESS: "0.0.0.0:3034"
      ML_MAINNET_WALLET_RPC_DAEMON_RPC_USERNAME: "${WALLET_RPC_USERNAME}"
      ML_MAINNET_WALLET_RPC_DAEMON_RPC_PASSWORD: "${WALLET_RPC_PASSWORD}"
      ML_TESTNET_WALLET_RPC_DAEMON_NODE_RPC_ADDRESS: "node-daemon:3030"
      ML_TESTNET_WALLET_RPC_DAEMON_NODE_RPC_USERNAME: "${NODE_RPC_USERNAME}"
      ML_TESTNET_WALLET_RPC_DAEMON_NODE_RPC_PASSWORD: "${NODE_RPC_PASSWORD}"
      ML_TESTNET_WALLET_RPC_DAEMON_RPC_BIND_ADDRESS: "0.0.0.0:3034"
      ML_TESTNET_WALLET_RPC_DAEMON_RPC_USERNAME: "${WALLET_RPC_USERNAME}"
      ML_TESTNET_WALLET_RPC_DAEMON_RPC_PASSWORD: "${WALLET_RPC_PASSWORD}"
    restart: on-failure

  web-gui:
    image: "mintlayer/web-gui:latest"
    depends_on:
      - wallet-rpc-daemon
    volumes:
      - "./mintlayer-data:/app/mintlayer-data:ro"
      - "./mintlayer-data/uploads:/app/uploads"
      - "./mintlayer-data/prefs:/app/prefs"
    ports:
      - "127.0.0.1:4321:4321"
    environment:
      WALLET_RPC_URL: "http://wallet-rpc-daemon:3034"
      WALLET_RPC_USERNAME: "${WALLET_RPC_USERNAME}"
      WALLET_RPC_PASSWORD: "${WALLET_RPC_PASSWORD}"
      NODE_RPC_URL: "http://node-daemon:3030"
      NODE_RPC_USERNAME: "${NODE_RPC_USERNAME}"
      NODE_RPC_PASSWORD: "${NODE_RPC_PASSWORD}"
      NETWORK: "${NETWORK:-mainnet}"
      INDEXER_URL: "http://api-web-server:3000"
      PINATA_JWT: "${PINATA_JWT:-}"
      IPFS_PROVIDER: "${IPFS_PROVIDER:-}"
      FILEBASE_TOKEN: "${FILEBASE_TOKEN:-}"
      UI_PASSWORD_HASH: "${UI_PASSWORD_HASH:-}"
      UI_TOTP_SECRET: "${UI_TOTP_SECRET:-}"
      SESSION_SECRET: "${SESSION_SECRET}"
      WALLET_RPC_CMD: "${WALLET_RPC_CMD:-}"
      INDEXER_ENABLED: "${INDEXER_ENABLED:-false}"
      HOST: "0.0.0.0"
      PORT: "4321"
    restart: unless-stopped

  wallet-cli:
    <<: *common
    image: "mintlayer/wallet-cli:latest"
    command: "wallet-cli"
    depends_on:
      - wallet-rpc-daemon
    environment:
      <<: *common-env
      ML_WALLET_REMOTE_RPC_WALLET_ADDRESS: "wallet-rpc-daemon:3034"
      ML_WALLET_REMOTE_RPC_WALLET_USERNAME: "${WALLET_RPC_USERNAME}"
      ML_WALLET_REMOTE_RPC_WALLET_PASSWORD: "${WALLET_RPC_PASSWORD}"
    profiles:
      - wallet_cli

  postgres:
    image: "postgres:16-alpine"
    volumes:
      - "postgres-data:/var/lib/postgresql/data"
    environment:
      POSTGRES_USER: "${POSTGRES_USER:-mintlayer}"
      POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:-}"
      POSTGRES_DB: "${POSTGRES_DB:-mintlayer}"
    profiles:
      - indexer
    restart: unless-stopped

  api-blockchain-scanner-daemon:
    <<: *common
    image: "mintlayer/api-blockchain-scanner-daemon:latest"
    labels:
      com.centurylinklabs.watchtower.enable: "true"
    depends_on:
      - node-daemon
      - postgres
    environment:
      <<: *common-env
      RUST_LOG: "${RUST_LOG:-info}"
      ML_API_SCANNER_DAEMON_NETWORK: "${NETWORK:-mainnet}"
      ML_API_SCANNER_DAEMON_NODE_RPC_ADDRESS: "node-daemon:3030"
      ML_API_SCANNER_DAEMON_NODE_RPC_USERNAME: "${NODE_RPC_USERNAME}"
      ML_API_SCANNER_DAEMON_NODE_RPC_PASSWORD: "${NODE_RPC_PASSWORD}"
      ML_API_SCANNER_DAEMON_POSTGRES_HOST: "postgres"
      ML_API_SCANNER_DAEMON_POSTGRES_USER: "${POSTGRES_USER:-mintlayer}"
      ML_API_SCANNER_DAEMON_POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:-}"
      ML_API_SCANNER_DAEMON_POSTGRES_DATABASE: "${POSTGRES_DB:-mintlayer}"
    profiles:
      - indexer
    restart: unless-stopped

  api-web-server:
    image: "mintlayer/api-web-server:latest"
    labels:
      com.centurylinklabs.watchtower.enable: "true"
    depends_on:
      - postgres
      - node-daemon
    environment:
      ML_API_WEB_SRV_NETWORK: "${NETWORK:-mainnet}"
      ML_API_WEB_SRV_BIND_ADDRESS: "0.0.0.0:3000"
      ML_API_WEB_SRV_NODE_RPC_ADDRESS: "node-daemon:3030"
      ML_API_WEB_SRV_NODE_RPC_USERNAME: "${NODE_RPC_USERNAME}"
      ML_API_WEB_SRV_NODE_RPC_PASSWORD: "${NODE_RPC_PASSWORD}"
      ML_API_WEB_SRV_POSTGRES_HOST: "postgres"
      ML_API_WEB_SRV_POSTGRES_USER: "${POSTGRES_USER:-mintlayer}"
      ML_API_WEB_SRV_POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:-}"
      ML_API_WEB_SRV_POSTGRES_DATABASE: "${POSTGRES_DB:-mintlayer}"
    profiles:
      - indexer
    restart: unless-stopped

  caddy:
    image: caddy:alpine
    command: caddy reverse-proxy --from https://${DOMAIN} --to web-gui:4321
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - "caddy-data:/data"
      - "caddy-config:/config"
    depends_on:
      - web-gui
    profiles:
      - https
    restart: unless-stopped

  duckdns:
    image: lscr.io/linuxserver/duckdns:latest
    environment:
      SUBDOMAINS: "${DUCKDNS_SUBDOMAIN:-}"
      TOKEN: "${DUCKDNS_TOKEN:-}"
      TZ: "UTC"
      LOG_FILE: "false"
    profiles:
      - duckdns
    restart: unless-stopped

volumes:
  postgres-data:
  caddy-data:
  caddy-config:
'@
        Write-Utf8 $composePath $compose
        Ok-ML "docker-compose.yml written to $($script:InstallDir)"
    }
    Divider-ML
}

# ── Trap unhandled exceptions so the window never silently closes ─────────────
trap {
    Write-Host ""
    Err-ML "Unexpected error: $_"
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}

# ─────────────────────────────────────────────────────────────────────────────
# Prereqs + bootstrap
# ─────────────────────────────────────────────────────────────────────────────
Invoke-CheckPrereqs
Invoke-Bootstrap

# ── Banner ────────────────────────────────────────────────────────────────────
Clear-Host
Write-Host ""
Write-Host "${CYAN}${BOLD}  ███╗   ███╗██╗███╗   ██╗████████╗██╗      █████╗ ██╗   ██╗███████╗██████╗ ${RESET}"
Write-Host "${CYAN}${BOLD}  ████╗ ████║██║████╗  ██║╚══██╔══╝██║     ██╔══██╗╚██╗ ██╔╝██╔════╝██╔══██╗${RESET}"
Write-Host "${CYAN}${BOLD}  ██╔████╔██║██║██╔██╗ ██║   ██║   ██║     ███████║ ╚████╔╝ █████╗  ██████╔╝${RESET}"
Write-Host "${CYAN}${BOLD}  ██║╚██╔╝██║██║██║╚██╗██║   ██║   ██║     ██╔══██║  ╚██╔╝  ██╔══╝  ██╔══██╗${RESET}"
Write-Host "${CYAN}${BOLD}  ██║ ╚═╝ ██║██║██║ ╚████║   ██║   ███████╗██║  ██║   ██║   ███████╗██║  ██║${RESET}"
Write-Host "${CYAN}${BOLD}  ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝${RESET}"
Write-Host ""
Write-Host "  ${BOLD}Web GUI Setup${RESET}  ${GRAY}— node + wallet-rpc-daemon + web interface${RESET}"
Write-Host ""
Write-Host "${GRAY}  This script writes your .env and starts the Docker stack.${RESET}"
Write-Host ""

# ── Step 1 — Network ─────────────────────────────────────────────────────────
Step-ML "Network"
Hint-ML "mainnet uses real ML tokens; testnet is for experimentation"
Hint-ML ""
$networkChoice = Choose-ML "Which network?" @("mainnet  — real funds", "testnet  — for testing, no real value")
$Network = if ($networkChoice -like "*mainnet*") { "mainnet" } else { "testnet" }
Divider-ML

# ── Step 2 — Passwords ───────────────────────────────────────────────────────
Step-ML "Passwords"
Hint-ML "Two internal RPC services need authentication."
Hint-ML ""
$useRandom = Confirm-ML "Generate secure random passwords automatically?" 'Y'
if ($useRandom -eq 'yes') {
    $NodeRpcPassword   = New-RandomPassword
    $WalletRpcPassword = New-RandomPassword
    Ok-ML "Generated random passwords (saved to .env)"
} else {
    Ask-ML "Node RPC password"
    Hint-ML "Used by node-daemon — not exposed outside Docker"
    do {
        $NodeRpcPassword = PromptSecret-ML "Password:"
        if ($NodeRpcPassword.Length -lt 8) { Write-Host "${CYAN}│${RESET}  ${RED}Password must be at least 8 characters${RESET}" }
    } while ($NodeRpcPassword.Length -lt 8)

    Ask-ML "Wallet RPC password"
    Hint-ML "Used by wallet-rpc-daemon — not exposed outside Docker"
    do {
        $WalletRpcPassword = PromptSecret-ML "Password:"
        if ($WalletRpcPassword.Length -lt 8) { Write-Host "${CYAN}│${RESET}  ${RED}Password must be at least 8 characters${RESET}" }
    } while ($WalletRpcPassword.Length -lt 8)
}
$NodeRpcUsername   = "node_user"
$WalletRpcUsername = "wallet_user"
Divider-ML

# ── Step 3 — Web UI access ───────────────────────────────────────────────────
Step-ML "Web UI access"
Hint-ML "Protect the wallet interface with a password and authenticator app (TOTP 2FA)."
Hint-ML ""
Ask-ML "Web UI password"
Hint-ML "Used to sign in to the wallet web interface."
Hint-ML "Choose a strong password — this guards access to your wallet."
$UiPassword = ''; $UiPasswordConfirm = ''
do {
    do {
        $UiPassword = PromptSecret-ML "Password:"
        if ($UiPassword.Length -lt 8) { Write-Host "${CYAN}│${RESET}  ${RED}Password must be at least 8 characters${RESET}" }
    } while ($UiPassword.Length -lt 8)
    $UiPasswordConfirm = PromptSecret-ML "Confirm password:"
    if ($UiPassword -ne $UiPasswordConfirm) { Write-Host "${CYAN}│${RESET}  ${RED}Passwords do not match, try again${RESET}" }
} while ($UiPassword -ne $UiPasswordConfirm)

Write-Host "${CYAN}│${RESET}"
Hint-ML "Hashing password (this may take a moment)..."
$UiPasswordHash = New-PasswordHash -Password $UiPassword
Ok-ML "Password hashed"

$UiTotpSecret  = New-TotpSecret
$SessionSecret = New-SessionSecret
$TotpUri       = "otpauth://totp/Mintlayer%20GUI?secret=${UiTotpSecret}&issuer=Mintlayer"

Write-Host "${CYAN}│${RESET}"
Ok-ML "TOTP secret generated"
Write-Host "${CYAN}│${RESET}"
Write-Host "${CYAN}│${RESET}  ${BOLD}Scan this with Google Authenticator, Authy, or any TOTP app:${RESET}"
Write-Host "${CYAN}│${RESET}"
Write-Host "${CYAN}│${RESET}  Paste this URI into ${CYAN}https://qr.io${RESET} to generate a QR code:"
Write-Host "${CYAN}│${RESET}  ${GRAY}$TotpUri${RESET}"
Write-Host "${CYAN}│${RESET}"
Hint-ML "Or enter the secret manually: ${BOLD}${UiTotpSecret}${RESET}"
Write-Host "${CYAN}│${RESET}"

$openQr = Confirm-ML "Open QR code in your browser now?" 'Y'
if ($openQr -eq 'yes') {
    Start-Process ("https://qr.io/?text=" + [Uri]::EscapeDataString($TotpUri))
}

Write-Host "${CYAN}│${RESET}"
Warn-ML "Scan the QR code / save the TOTP secret NOW — it will not be shown again."
Write-Host "${CYAN}│${RESET}"
$scanned = 'no'
while ($scanned -ne 'yes') {
    $scanned = Confirm-ML "I have scanned the QR code / saved the TOTP secret" 'N'
    if ($scanned -ne 'yes') {
        Write-Host "${CYAN}│${RESET}  ${RED}Please scan or save the TOTP secret before continuing.${RESET}"
        Write-Host "${CYAN}│${RESET}  ${GRAY}$TotpUri${RESET}"
    }
}
Ok-ML "2FA configured"
Divider-ML

# ── Step 4 — HTTPS ───────────────────────────────────────────────────────────
Step-ML "HTTPS / Public access"
Hint-ML "Caddy can automatically provision a free TLS certificate (Let's Encrypt)"
Hint-ML "so the GUI is served over HTTPS — recommended for internet-facing servers."
Hint-ML ""
$httpsSetup = Confirm-ML "Set up HTTPS with automatic TLS certificate?" 'N'
$Domain = ''; $DuckdnsSubdomain = ''; $DuckdnsToken = ''

if ($httpsSetup -eq 'yes') {
    $domainType = Choose-ML "How will you reach this server?" @(
        "I have a domain name already pointing at this server's IP",
        "Set up a free DuckDNS subdomain (e.g. mywallet.duckdns.org)")

    if ($domainType -like "*domain name*") {
        Ask-ML "Domain name"
        Hint-ML "e.g. wallet.example.com — DNS must already resolve to this server"
        do { $Domain = Prompt-ML "Domain:" } while ([string]::IsNullOrEmpty($Domain))
        Ok-ML "Domain: $Domain"
    } else {
        Ask-ML "DuckDNS setup"
        Hint-ML "1. Go to https://www.duckdns.org and sign in (free, no expiry)"
        Hint-ML "2. Create a subdomain, e.g. 'mywallet' → mywallet.duckdns.org"
        Hint-ML "3. Copy the token shown at the top of the page"
        Write-Host "${CYAN}│${RESET}"
        do { $DuckdnsSubdomain = Prompt-ML "Subdomain (without .duckdns.org):" } while ([string]::IsNullOrEmpty($DuckdnsSubdomain))
        do { $DuckdnsToken = PromptSecret-ML "DuckDNS token:" } while ([string]::IsNullOrEmpty($DuckdnsToken))
        $Domain = "$DuckdnsSubdomain.duckdns.org"
        Ok-ML "DuckDNS configured — $Domain"
    }
    Write-Host "${CYAN}│${RESET}"
    Warn-ML "Ensure ports 80 and 443 are open in your firewall / router."
}
Divider-ML

# ── Step 5 — Indexer ─────────────────────────────────────────────────────────
Step-ML "Indexer stack"
Hint-ML "The indexer adds PostgreSQL + blockchain scanner + REST API."
Hint-ML "It enables Token Management and Trading in the web UI."
Hint-ML "Requires more disk space and memory."
Hint-ML ""
$enableIndexer   = Confirm-ML "Enable the indexer? (disable only if you don't need Token Management or Trading)" 'Y'
$PostgresPassword = ''
if ($enableIndexer -eq 'yes') {
    if ($useRandom -eq 'yes') {
        $PostgresPassword = New-RandomPassword
        Ok-ML "Generated random PostgreSQL password (saved to .env)"
    } else {
        Ask-ML "PostgreSQL password"
        do {
            $PostgresPassword = PromptSecret-ML "Password:"
            if ($PostgresPassword.Length -lt 8) { Write-Host "${CYAN}│${RESET}  ${RED}Password must be at least 8 characters${RESET}" }
        } while ($PostgresPassword.Length -lt 8)
    }
}
Divider-ML

# ── Step 6 — IPFS ─────────────────────────────────────────────────────────────
Step-ML "IPFS Storage (optional)"
Hint-ML "Enables automatic upload of token/NFT images and metadata to IPFS."
Hint-ML "Without this, URLs can still be entered manually — configure later in Settings."
Hint-ML ""
$setupIpfs = Confirm-ML "Configure IPFS now?" 'N'
$IpfsProvider = ''; $FilebaseToken = ''; $PinataJwt = ''
if ($setupIpfs -eq 'yes') {
    $ipfsChoice = Choose-ML "Choose IPFS provider:" @(
        "Filebase (recommended — 5 GB free, always public)",
        "Pinata (paid account required to make files public)")
    if ($ipfsChoice -like "*Filebase*") {
        $IpfsProvider = "filebase"
        Ask-ML "Filebase API key"
        Hint-ML "Find it at https://console.filebase.com/keys"
        do { $FilebaseToken = PromptSecret-ML "API key:" } while ([string]::IsNullOrEmpty($FilebaseToken))
        Ok-ML "Filebase API key saved"
    } else {
        $IpfsProvider = "pinata"
        Ask-ML "Pinata JWT"
        do { $PinataJwt = PromptSecret-ML "JWT:" } while ([string]::IsNullOrEmpty($PinataJwt))
        Ok-ML "Pinata JWT saved"
    }
}
Divider-ML

# ── Step 7 — Telegram ─────────────────────────────────────────────────────────
Step-ML "Telegram Notifications (optional)"
Hint-ML "Receive wallet alerts via a Telegram bot. Configure later in Settings."
Hint-ML ""
$setupTelegram = Confirm-ML "Configure Telegram notifications now?" 'N'
$TelegramBotToken = ''; $TelegramChatId = ''
if ($setupTelegram -eq 'yes') {
    Hint-ML "1. Create a bot with @BotFather on Telegram"
    Hint-ML "2. Start a chat with your bot and send /start"
    Hint-ML "3. Use @userinfobot to get your chat ID"
    Hint-ML ""
    Ask-ML "Telegram bot token"
    do { $TelegramBotToken = PromptSecret-ML "Bot token:" } while ([string]::IsNullOrEmpty($TelegramBotToken))
    Ask-ML "Telegram chat ID"
    do { $TelegramChatId = Prompt-ML "Chat ID:" } while ([string]::IsNullOrEmpty($TelegramChatId))
    Ok-ML "Telegram configured"
}
Divider-ML

# ── Step 8 — Firewall ─────────────────────────────────────────────────────────
$P2pPort = if ($Network -eq 'mainnet') { 3031 } else { 13031 }
$setupFirewall = 'no'; $openP2pPort = 'no'
Step-ML "Windows Firewall"
Hint-ML "Adds inbound Allow rules for ports 80, 443, 4321."
Hint-ML "Does NOT block other ports — only adds rules for Mintlayer."
Hint-ML ""
if (-not $script:IsAdmin) {
    Hint-ML "Skipping — not running as Administrator."
    Hint-ML "Re-run as Administrator to configure Windows Firewall, or add rules manually."
} else {
    $setupFirewall = Confirm-ML "Add Windows Firewall rules now?" 'N'
    if ($setupFirewall -eq 'yes') {
        $openP2pPort = Confirm-ML "Also open node P2P port ${P2pPort}/tcp for inbound peer connections?" 'N'
    }
}
Divider-ML

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host ""
Step-ML "Summary"
Write-Host "${CYAN}│${RESET}"
$guiUrl = if ($httpsSetup -eq 'yes' -and $Domain) { "https://$Domain" } else { "http://localhost:4321" }
Write-Host "${CYAN}│${RESET}  $("Network:".PadRight(22)) ${BOLD}$Network${RESET}"
Write-Host "${CYAN}│${RESET}  $("Passwords:".PadRight(22)) ${BOLD}$(if ($useRandom -eq 'yes') {'randomly generated'} else {'custom'})${RESET}"
Write-Host "${CYAN}│${RESET}  $("Web UI auth:".PadRight(22)) ${BOLD}password + TOTP 2FA${RESET}"
Write-Host "${CYAN}│${RESET}  $("Web GUI:".PadRight(22)) ${BOLD}$guiUrl${RESET}"
Write-Host "${CYAN}│${RESET}  $("Indexer:".PadRight(22)) ${BOLD}$(if ($enableIndexer -eq 'yes') {'enabled — Token Management + Trading active'} else {'disabled'})${RESET}"
Write-Host "${CYAN}│${RESET}  $("IPFS storage:".PadRight(22)) ${BOLD}$(if ($IpfsProvider) {$IpfsProvider} else {'disabled — configure later in Settings'})${RESET}"
Write-Host "${CYAN}│${RESET}  $("Telegram:".PadRight(22)) ${BOLD}$(if ($TelegramBotToken) {'configured'} else {'disabled — configure later in Settings'})${RESET}"
Write-Host "${CYAN}│${RESET}"
$proceed = Confirm-ML "Write .env and continue?" 'Y'
if ($proceed -ne 'yes') {
    Write-Host ""
    Warn-ML "Setup cancelled. Nothing was written."
    Exit-ML 0
}
Divider-ML

# ── Write .env ────────────────────────────────────────────────────────────────
$IndexerEnabled = if ($enableIndexer -eq 'yes') { 'true' } else { 'false' }
$EnableHttps    = if ($httpsSetup -eq 'yes') { 'true' } else { 'false' }
$WalletRpcCmd   = "wallet-rpc-daemon $Network"

$envContent = @"
# Generated by windows.ps1 on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
# ─────────────────────────────────────────

NETWORK=$Network

# On Windows, Docker Desktop uses a WSL2 VM with fixed UID/GID 1000
ML_USER_ID=1000
ML_GROUP_ID=1000

WALLET_RPC_CMD=$WalletRpcCmd

NODE_RPC_USERNAME=$NodeRpcUsername
NODE_RPC_PASSWORD=$NodeRpcPassword

WALLET_RPC_USERNAME=$WalletRpcUsername
WALLET_RPC_PASSWORD=$WalletRpcPassword

INDEXER_ENABLED=$IndexerEnabled

SESSION_SECRET=$SessionSecret

RUST_LOG=info

POSTGRES_USER=mintlayer
POSTGRES_PASSWORD=$PostgresPassword
POSTGRES_DB=mintlayer

ENABLE_HTTPS=$EnableHttps
DOMAIN=$Domain
DUCKDNS_SUBDOMAIN=$DuckdnsSubdomain
DUCKDNS_TOKEN=$DuckdnsToken
"@
Write-Utf8 (Join-Path $script:InstallDir '.env') $envContent
Ok-ML ".env written"

# ── Write SQLite credentials ──────────────────────────────────────────────────
$prefsDir = Join-Path $script:InstallDir 'mintlayer-data\prefs'
New-Item -ItemType Directory -Force -Path $prefsDir | Out-Null

$sqlLines = [System.Collections.Generic.List[string]]::new()
$sqlLines.Add("CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
$sqlLines.Add("INSERT OR REPLACE INTO prefs VALUES ('auth.password_hash', '`"$UiPasswordHash`"');")
$sqlLines.Add("INSERT OR REPLACE INTO prefs VALUES ('auth.totp_secret',   '`"$UiTotpSecret`"');")
if ($IpfsProvider)     { $sqlLines.Add("INSERT OR REPLACE INTO prefs VALUES ('ipfs.provider',       '`"$IpfsProvider`"');") }
if ($FilebaseToken)    { $sqlLines.Add("INSERT OR REPLACE INTO prefs VALUES ('ipfs.filebase_token', '`"$FilebaseToken`"');") }
if ($PinataJwt)        { $sqlLines.Add("INSERT OR REPLACE INTO prefs VALUES ('ipfs.pinata_jwt',     '`"$PinataJwt`"');") }
if ($TelegramBotToken) { $sqlLines.Add("INSERT OR REPLACE INTO prefs VALUES ('telegram.bot_token',  '`"$TelegramBotToken`"');") }
if ($TelegramChatId)   { $sqlLines.Add("INSERT OR REPLACE INTO prefs VALUES ('telegram.chat_id',    '`"$TelegramChatId`"');") }

$sql     = $sqlLines -join "`n"
$sqlFile = [System.IO.Path]::GetTempFileName()
Write-Utf8 $sqlFile $sql

$prefsDirDocker = ConvertTo-DockerPath $prefsDir
$sqlFileDocker  = ConvertTo-DockerPath $sqlFile

docker run --rm `
    -v "${prefsDirDocker}:/prefs" `
    -v "${sqlFileDocker}:/init.sql:ro" `
    alpine sh -c 'apk add -q --no-progress sqlite >/dev/null 2>&1 && sqlite3 /prefs/mintlayer_prefs.sqlite < /init.sql'

Remove-Item $sqlFile -ErrorAction SilentlyContinue

$dbPath = Join-Path $prefsDir 'mintlayer_prefs.sqlite'
if (-not (Test-Path $dbPath) -or (Get-Item $dbPath).Length -eq 0) {
    Warn-ML "SQLite file was not created. Docker Desktop file sharing may be misconfigured."
    Hint-ML "Open Docker Desktop → Settings → Resources → File Sharing"
    Hint-ML "Ensure the drive containing '$($script:InstallDir)' is listed, then re-run the script."
} else {
    Ok-ML "Credentials written to mintlayer-data\prefs\mintlayer_prefs.sqlite"
}

New-Item -ItemType Directory -Force -Path (Join-Path $script:InstallDir 'mintlayer-data') | Out-Null
Ok-ML "mintlayer-data\ directory ready"

# ── Start services ────────────────────────────────────────────────────────────
Write-Host "${CYAN}│${RESET}"
$start = Confirm-ML "Start services now with docker compose?" 'Y'

if ($start -eq 'yes') {
    Write-Host "${CYAN}│${RESET}"
    Hint-ML "Pulling images and starting containers..."
    Write-Host "${CYAN}│${RESET}"

    $profiles = @()
    if ($enableIndexer -eq 'yes')        { $profiles += '--profile', 'indexer' }
    if ($httpsSetup -eq 'yes')           { $profiles += '--profile', 'https' }
    if ($DuckdnsSubdomain)               { $profiles += '--profile', 'duckdns' }

    docker compose pull --quiet
    & docker compose @($profiles + @('up', '-d'))
    Ok-ML "Services started"
}

# ── Firewall rules ────────────────────────────────────────────────────────────
if ($setupFirewall -eq 'yes' -and $script:IsAdmin) {
    Write-Host "${CYAN}│${RESET}"
    Hint-ML "Applying Windows Firewall rules..."
    Get-NetFirewallRule -DisplayName 'Mintlayer*' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName 'Mintlayer Web GUI (HTTP)'  -Direction Inbound -Protocol TCP -LocalPort 80   -Action Allow | Out-Null
    New-NetFirewallRule -DisplayName 'Mintlayer Web GUI (HTTPS)' -Direction Inbound -Protocol TCP -LocalPort 443  -Action Allow | Out-Null
    New-NetFirewallRule -DisplayName 'Mintlayer Web GUI (App)'   -Direction Inbound -Protocol TCP -LocalPort 4321 -Action Allow | Out-Null
    if ($openP2pPort -eq 'yes') {
        New-NetFirewallRule -DisplayName "Mintlayer Node P2P ($P2pPort)" -Direction Inbound -Protocol TCP -LocalPort $P2pPort -Action Allow | Out-Null
        Ok-ML "Firewall rules added — HTTP (80), HTTPS (443), App (4321), P2P ($P2pPort)"
    } else {
        Ok-ML "Firewall rules added — HTTP (80), HTTPS (443), App (4321)"
    }
}

# ── Desktop & Start Menu shortcuts ───────────────────────────────────────────
$createShortcuts = Confirm-ML "Create Desktop and Start Menu shortcuts?" 'Y'
if ($createShortcuts -eq 'yes') {
    $iconPath = Join-Path $script:InstallDir 'mintlayer.ico'
    [System.IO.File]::WriteAllBytes($iconPath, [Convert]::FromBase64String($script:FaviconBase64))

    $shortcutUrl = $guiUrl
    $urlContent  = "[InternetShortcut]`r`nURL=$shortcutUrl`r`nIconFile=$iconPath`r`nIconIndex=0`r`n"

    $desktop   = [Environment]::GetFolderPath('Desktop')
    $startMenu = [Environment]::GetFolderPath('Programs')

    [System.IO.File]::WriteAllText(
        (Join-Path $desktop   'Mintlayer Web GUI.url'), $urlContent,
        [System.Text.ASCIIEncoding]::new())
    [System.IO.File]::WriteAllText(
        (Join-Path $startMenu 'Mintlayer Web GUI.url'), $urlContent,
        [System.Text.ASCIIEncoding]::new())

    Ok-ML "Shortcuts created on Desktop and Start Menu → $shortcutUrl"
}

# ── Done ──────────────────────────────────────────────────────────────────────
Divider-ML
Write-Host ""
Write-Host "${GREEN}${BOLD}  Setup complete!${RESET}"
Write-Host ""
Write-Host "  ${BOLD}Next steps${RESET}"
Write-Host ""
Write-Host "  ${YELLOW}1.${RESET} Create your wallet via the web UI:"
Write-Host "     ${CYAN}$guiUrl/setup${RESET}"
Write-Host ""
Write-Host "  ${DIM}Other useful commands (run from $($script:InstallDir)):${RESET}"
Write-Host "  ${GRAY}docker compose logs -f wallet-rpc-daemon${RESET}"
Write-Host "  ${GRAY}docker compose run --rm wallet-cli${RESET}"
Write-Host "  ${GRAY}docker compose down${RESET}"
Write-Host ""
Write-Host "  ${DIM}Note: mainnet sync takes hours on first run.${RESET}"
Write-Host "  ${DIM}Balance and history appear once the node is fully synced.${RESET}"
Write-Host ""
Read-Host "Press Enter to close"
