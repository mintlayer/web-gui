#Requires -Version 5.1
# ─────────────────────────────────────────────────────────────────────────────
# Mintlayer Web GUI — Windows installer (Docker Desktop, WSL2 backend)
# Served at https://get.mintlayer.org/windows.ps1
#
# Wizard:
#   powershell -ExecutionPolicy Bypass -Command "irm https://get.mintlayer.org/windows.ps1 | iex"
#
# Non-interactive (for AI agents / automation):
#   $env:ML_NONINTERACTIVE = "1"          # alias: NONINTERACTIVE=1
#   $env:NETWORK           = "mainnet"    # mainnet | testnet (default: mainnet)
#   $env:INSTALL_DIR       = "$HOME\mintlayer"
#   $env:WEB_UI_PASSWORD   = "..."        # default: generated, printed once
#   powershell -ExecutionPolicy Bypass -Command "irm https://get.mintlayer.org/windows.ps1 | iex"
#
# The web UI password is printed once in the final summary; the TOTP secret is
# written to mintlayer-totp.txt in the install directory (never to stdout).
# See agent-prompt.txt.
# ─────────────────────────────────────────────────────────────────────────────
param()

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ── Non-interactive mode ──────────────────────────────────────────────────────
# ML_NONINTERACTIVE=1 (alias: NONINTERACTIVE=1) skips every prompt. Values are
# taken from the environment with sane defaults:
#   INSTALL_DIR ($HOME\mintlayer)  NETWORK (mainnet)  WEB_UI_PASSWORD (generated)
# Intended for AI coding agents and automation — see agent-prompt.txt.
$script:NonInteractive = ($env:ML_NONINTERACTIVE -eq '1' -or $env:NONINTERACTIVE -eq '1')

function Exit-ML([int]$Code = 0) {
    if (-not $script:NonInteractive) { Read-Host "Press Enter to close" | Out-Null }
    exit $Code
}

# ── Execution policy check (only when run as a saved file) ────────────────────
if (-not [string]::IsNullOrEmpty($PSCommandPath)) {
    $policy = Get-ExecutionPolicy -Scope CurrentUser
    if ($policy -eq 'Restricted') {
        Write-Host "ExecutionPolicy is Restricted. Run this first:" -ForegroundColor Yellow
        Write-Host "  Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned" -ForegroundColor Cyan
        Write-Host "Then re-run the script." -ForegroundColor Gray
        Exit-ML 1
    }
}

# ── Admin detection (Windows only; non-Windows/dev runs stay non-admin) ───────
$script:IsAdmin = $false
try {
    $wi = [Security.Principal.WindowsIdentity]::GetCurrent()
    $script:IsAdmin = ([Security.Principal.WindowsPrincipal]$wi).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }

# ── Colors (VT escapes built from [char]27 so PowerShell 5.1 renders them) ────
$script:UseAnsi = ($PSVersionTable.PSVersion.Major -ge 7) -or
                  $env:WT_SESSION -or $env:TERM_PROGRAM -or
                  ($env:TERM -and $env:TERM -ne 'dumb')
if ($script:UseAnsi) {
    $ESC   = [char]27
    $RESET = "$ESC[0m";  $BOLD = "$ESC[1m";  $DIM   = "$ESC[2m"
    $CYAN  = "$ESC[36m"; $GREEN = "$ESC[32m"; $YELLOW = "$ESC[33m"
    $RED   = "$ESC[31m"; $GRAY  = "$ESC[90m"
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

function Die-ML { Err-ML ($args -join ' '); Exit-ML 1 }

function Prompt-ML([string]$Question, [string]$Default = '') {
    if ($Default) { Write-Host "${CYAN}│${RESET}  $Question ${GRAY}($Default)${RESET} " -NoNewline }
    else          { Write-Host "${CYAN}│${RESET}  $Question " -NoNewline }
    $val = Read-Host
    if ([string]::IsNullOrEmpty($val) -and $Default) { return $Default }
    return $val
}

function PromptSecret-ML([string]$Question) {
    Write-Host "${CYAN}│${RESET}  $Question " -NoNewline
    # Read-Host -AsSecureString needs the Windows console host; on other hosts
    # (e.g. pwsh for Linux in CI/dev) fall back to a plain read.
    if ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) {
        $ss  = Read-Host -AsSecureString
        $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($ss)
        try   { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    } else {
        return (Read-Host)
    }
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

function Get-HomeDir {
    if ($env:USERPROFILE) { return $env:USERPROFILE }
    if ($env:HOME)        { return $env:HOME }
    return (Get-Location).Path
}

# ── Docker helpers ────────────────────────────────────────────────────────────
function Test-DockerRunning {
    docker info 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
}

# ── WSL2 / virtualization preflight ──────────────────────────────────────────
function Invoke-EnsureWsl2 {
    # CPU virtualization — if off, nothing else will work
    try {
        $cpu = Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop | Select-Object -First 1
        if ($cpu -and $cpu.VirtualizationFirmwareEnabled -eq $false) {
            Die-ML "CPU virtualization is disabled. Enable VT-x (Intel) or AMD-V in your BIOS/UEFI settings, then reboot and re-run."
        }
    } catch { }

    # VirtualMachinePlatform + WSL optional features (requires admin to query)
    $vmp = $null; $wsl = $null
    try {
        $vmp = Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -ErrorAction Stop
        $wsl = Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux -ErrorAction Stop
    } catch { }

    $needEnable = @()
    if ($vmp -and $vmp.State -ne 'Enabled') { $needEnable += 'VirtualMachinePlatform' }
    if ($wsl -and $wsl.State -ne 'Enabled') { $needEnable += 'Microsoft-Windows-Subsystem-Linux' }

    if ($needEnable.Count -gt 0) {
        if ($script:NonInteractive) {
            Die-ML "Required Windows features are not enabled: $($needEnable -join ', '). Enable them via 'Turn Windows features on or off' (Virtual Machine Platform + Windows Subsystem for Linux), reboot, then re-run."
        }
        Warn-ML "Required Windows features are not enabled: $($needEnable -join ', ')"
        Hint-ML "Docker Desktop requires WSL2 (Virtual Machine Platform + WSL)."
        Write-Host ""
        $enable = Confirm-ML "Enable these features now? (Administrator required; a reboot will be needed)" 'Y'
        if ($enable -eq 'yes') {
            foreach ($f in $needEnable) {
                Enable-WindowsOptionalFeature -Online -FeatureName $f -NoRestart | Out-Null
            }
            Ok-ML "Features enabled. Please reboot, then re-run this script."
            Exit-ML 0
        }
        Die-ML "Cannot install Docker Desktop without these features. Enable them in Windows Features and reboot."
    }
}

# ── check_prereqs ─────────────────────────────────────────────────────────────
function Invoke-CheckPrereqs {
    $dockerInstalled = (Get-ItemProperty 'HKLM:\SOFTWARE\Docker Inc.\Docker Desktop' `
        -Name Version -ErrorAction SilentlyContinue) -or
        (Get-Command docker -ErrorAction SilentlyContinue)

    if (-not $dockerInstalled) {
        if ($script:NonInteractive) {
            Die-ML "Docker Desktop is not installed. Install it from https://docs.docker.com/desktop/install/windows-install/ (WSL2 backend), launch it once, then re-run this script."
        }
        Warn-ML "Docker Desktop is not installed."
        Write-Host "${CYAN}│${RESET}"
        $winget = Get-Command winget -ErrorAction SilentlyContinue
        if ($winget -and $script:IsAdmin) {
            Invoke-EnsureWsl2
            $install = Confirm-ML "Install Docker Desktop automatically via winget?" 'Y'
            if ($install -eq 'yes') {
                Step-ML "Installing Docker Desktop"
                winget install --id Docker.DockerDesktop --scope machine `
                    --accept-source-agreements --accept-package-agreements
                if ($LASTEXITCODE -ne 0) {
                    Write-Host ""
                    Err-ML "Docker Desktop installation failed (exit code $LASTEXITCODE)."
                    Write-Host ""
                    Hint-ML "Download and install manually, then re-run this script:"
                    Hint-ML "  https://docs.docker.com/desktop/install/windows-install/"
                    Exit-ML 1
                }
                Write-Host ""
                Ok-ML "Docker Desktop installed. Please:"
                Hint-ML "1. Launch Docker Desktop from the Start Menu"
                Hint-ML "2. Complete the first-run setup wizard"
                Hint-ML "3. Wait for the whale icon in the system tray"
                Hint-ML "4. Re-run this script"
                Exit-ML 0
            }
        } elseif ($winget -and -not $script:IsAdmin) {
            Hint-ML "Automatic installation via winget requires an Administrator PowerShell."
            Hint-ML "Re-run as Administrator, or install manually:"
        } else {
            Hint-ML "winget is not available — install manually:"
        }
        Err-ML "Docker Desktop is required."
        Write-Host "  Download: https://docs.docker.com/desktop/install/windows-install/" -ForegroundColor Cyan
        Exit-ML 1
    }

    if (-not (Test-DockerRunning)) {
        Die-ML "Docker Desktop is installed but not running. Start Docker Desktop (whale icon in the system tray), wait for it to finish loading, then re-run this script."
    }

    docker compose version 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0 -and -not (Get-Command docker-compose -ErrorAction SilentlyContinue)) {
        Die-ML "Docker Compose is not available. Reinstall Docker Desktop (Compose v2 is bundled): https://docs.docker.com/desktop/install/windows-install/"
    }
}

# ── bootstrap: install dir + docker-compose.yml ───────────────────────────────
function Invoke-Bootstrap {
    Write-Host ""
    Write-Host "${CYAN}◆${RESET} ${BOLD}Install location${RESET}"
    if ($script:NonInteractive) {
        $script:InstallDir = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { Join-Path (Get-HomeDir) 'mintlayer' }
        Write-Host "${GRAY}│  Non-interactive: installing to $($script:InstallDir)${RESET}"
    } else {
        Write-Host "${GRAY}│  Where should Mintlayer Web GUI be installed?${RESET}"
        $default = Join-Path (Get-HomeDir) 'mintlayer'
        Write-Host "${CYAN}│${RESET}  Directory: ${GRAY}($default)${RESET} " -NoNewline
        $val = Read-Host
        $script:InstallDir = if ([string]::IsNullOrEmpty($val)) { $default } else { $val }
    }

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

# Both mainnet and testnet env vars are set to the same credential values.
# Only the vars matching the active NETWORK are picked up by each daemon.
x-node-rpc-env: &node-rpc-env
  ML_MAINNET_NODE_RPC_USERNAME: "${NODE_RPC_USERNAME}"
  ML_MAINNET_NODE_RPC_PASSWORD: "${NODE_RPC_PASSWORD}"
  ML_TESTNET_NODE_RPC_USERNAME: "${NODE_RPC_USERNAME}"
  ML_TESTNET_NODE_RPC_PASSWORD: "${NODE_RPC_PASSWORD}"

services:
  # ─────────────────────────────────────────
  # Core: Mintlayer full node
  # ─────────────────────────────────────────
  node-daemon:
    <<: *common
    # Images update via Watchtower (opt-in, profile "watchtower") or manual pulls.
    # For strict supply-chain pinning, set ML_*_IMAGE env overrides to a
    # digest-pinned ref, e.g. ML_NODE_DAEMON_IMAGE=mintlayer/node-daemon@sha256:<digest>.
    image: "${ML_NODE_DAEMON_IMAGE:-mintlayer/node-daemon:latest}"
    command: "node-daemon ${NETWORK:-mainnet}"
    environment:
      <<: [*common-env, *node-rpc-env]
      RUST_LOG: "${RUST_LOG:-info}"
      ML_MAINNET_NODE_RPC_BIND_ADDRESS: "0.0.0.0:3030"
      ML_TESTNET_NODE_RPC_BIND_ADDRESS: "0.0.0.0:3030"
    # Uncomment to expose the node RPC to the host
    # ports:
    #   - "3030:3030"

  # ─────────────────────────────────────────
  # Core: Wallet RPC daemon (headless wallet)
  # ─────────────────────────────────────────
  wallet-rpc-daemon:
    <<: *common
    image: "${ML_WALLET_RPC_DAEMON_IMAGE:-mintlayer/wallet-rpc-daemon:latest}"
    command: "${WALLET_RPC_CMD:-wallet-rpc-daemon mainnet}"
    depends_on:
      - node-daemon
    environment:
      <<: *common-env
      RUST_LOG: "${RUST_LOG:-info}"
      # Mainnet
      ML_MAINNET_WALLET_RPC_DAEMON_NODE_RPC_ADDRESS: "node-daemon:3030"
      ML_MAINNET_WALLET_RPC_DAEMON_NODE_RPC_USERNAME: "${NODE_RPC_USERNAME}"
      ML_MAINNET_WALLET_RPC_DAEMON_NODE_RPC_PASSWORD: "${NODE_RPC_PASSWORD}"
      ML_MAINNET_WALLET_RPC_DAEMON_RPC_BIND_ADDRESS: "0.0.0.0:3034"
      ML_MAINNET_WALLET_RPC_DAEMON_RPC_USERNAME: "${WALLET_RPC_USERNAME}"
      ML_MAINNET_WALLET_RPC_DAEMON_RPC_PASSWORD: "${WALLET_RPC_PASSWORD}"
      # Testnet
      ML_TESTNET_WALLET_RPC_DAEMON_NODE_RPC_ADDRESS: "node-daemon:3030"
      ML_TESTNET_WALLET_RPC_DAEMON_NODE_RPC_USERNAME: "${NODE_RPC_USERNAME}"
      ML_TESTNET_WALLET_RPC_DAEMON_NODE_RPC_PASSWORD: "${NODE_RPC_PASSWORD}"
      ML_TESTNET_WALLET_RPC_DAEMON_RPC_BIND_ADDRESS: "0.0.0.0:3034"
      ML_TESTNET_WALLET_RPC_DAEMON_RPC_USERNAME: "${WALLET_RPC_USERNAME}"
      ML_TESTNET_WALLET_RPC_DAEMON_RPC_PASSWORD: "${WALLET_RPC_PASSWORD}"
    restart: on-failure
    # ports:
    #   - "3034:3034"

  # ─────────────────────────────────────────
  # Web GUI (Astro SSR app)
  # ─────────────────────────────────────────
  web-gui:
    image: "${ML_WEB_GUI_IMAGE:-mintlayer/web-gui:latest}"
    depends_on:
      - wallet-rpc-daemon
    volumes:
      # Read-only access to wallet data for file backup download
      - "./mintlayer-data:/app/mintlayer-data:ro"
      # Shared with wallet-rpc-daemon's /home/mintlayer/ so uploaded wallet files
      # are accessible to the daemon at /home/mintlayer/uploads/<filename>
      - "./mintlayer-data/uploads:/app/uploads"
      # Server-side preferences (SQLite) — persists across browsers and restarts
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
      UI_PASSWORD_HASH: "${UI_PASSWORD_HASH}"
      UI_TOTP_SECRET: "${UI_TOTP_SECRET}"
      SESSION_SECRET: "${SESSION_SECRET}"
      WALLET_RPC_CMD: "${WALLET_RPC_CMD:-}"
      INDEXER_ENABLED: "${INDEXER_ENABLED:-false}"
      HOST: "0.0.0.0"
      PORT: "4321"
    restart: unless-stopped

  # ─────────────────────────────────────────
  # Optional: wallet-cli  (profile: wallet_cli)
  # Usage: docker compose run --rm wallet-cli
  # ─────────────────────────────────────────
  wallet-cli:
    <<: *common
    image: "${ML_WALLET_CLI_IMAGE:-mintlayer/wallet-cli:latest}"
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

  # ─────────────────────────────────────────
  # Optional: Indexer stack  (profile: indexer)
  # Start with: docker compose --profile indexer up -d
  # ─────────────────────────────────────────
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
    image: "${ML_API_SCANNER_IMAGE:-mintlayer/api-blockchain-scanner-daemon:latest}"
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
    image: "${ML_API_WEB_SERVER_IMAGE:-mintlayer/api-web-server:latest}"
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

  # ─────────────────────────────────────────
  # Optional: HTTPS via Caddy  (profile: https)
  # Automatically provisions a TLS certificate via Let's Encrypt.
  # Activate with: docker compose --profile https up -d
  # ─────────────────────────────────────────
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

  # ─────────────────────────────────────────
  # Optional: DuckDNS dynamic DNS updater  (profile: duckdns)
  # Keeps your duckdns.org subdomain pointing at this server's IP.
  # Activate alongside https: docker compose --profile https --profile duckdns up -d
  # ─────────────────────────────────────────
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
    if (-not $script:NonInteractive) {
        Write-Host ""
        Read-Host "Press Enter to close" | Out-Null
    }
    exit 1
}

# ─────────────────────────────────────────────────────────────────────────────
# Prereqs + bootstrap
# ─────────────────────────────────────────────────────────────────────────────
Invoke-CheckPrereqs
Invoke-Bootstrap

# ── Banner ────────────────────────────────────────────────────────────────────
if (-not $script:NonInteractive) { Clear-Host }
Write-Host ""
Write-Host "${CYAN}${BOLD}  ███╗   ███╗██╗███╗   ██╗████████╗██╗      █████╗ ██╗   ██╗███████╗██████╗ ${RESET}"
Write-Host "${CYAN}${BOLD}  ████╗ ████║██║████╗  ██║╚══██╔══╝██║     ██╔══██╗╚██╗ ██╔╝██╔════╝██╔══██╗${RESET}"
Write-Host "${CYAN}${BOLD}  ██╔████╔██║██║██╔██╗ ██║   ██║   ██║     ███████║ ╚████╔╝ █████╗  ██████╔╝${RESET}"
Write-Host "${CYAN}${BOLD}  ██║╚██╔╝██║██║╚██╗██║   ██║   ██║     ██╔══██╗  ╚██╔╝  ██╔══╝  ██╔══██╗${RESET}"
Write-Host "${CYAN}${BOLD}  ██║ ╚═╝ ██║██║██║ ╚████║   ██║   ███████╗██║  ██║   ██║   ███████╗██║  ██║${RESET}"
Write-Host "${CYAN}${BOLD}  ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝   ╚═╝   ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝${RESET}"
Write-Host ""
Write-Host "  ${BOLD}Web GUI Setup${RESET}  ${GRAY}— node + wallet-rpc-daemon + web interface${RESET}"
Write-Host ""
if ($script:NonInteractive) {
    Write-Host "${GRAY}  Non-interactive mode — values from environment, no prompts.${RESET}"
    Write-Host ""
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 1 — Network
# ─────────────────────────────────────────────────────────────────────────────
if ($script:NonInteractive) {
    Step-ML "Network"
    $Network = if ($env:NETWORK) { $env:NETWORK } else { 'mainnet' }
    if ($Network -ne 'mainnet' -and $Network -ne 'testnet') {
        Die-ML "Invalid NETWORK='$Network'. Must be 'mainnet' or 'testnet'."
    }
    Ok-ML "Network: $Network"
    Divider-ML
} else {
    Step-ML "Network"
    Hint-ML "mainnet uses real ML tokens; testnet is for experimentation"
    Hint-ML ""
    $networkChoice = Choose-ML "Which network?" @("mainnet  — real funds", "testnet  — for testing, no real value")
    $Network = if ($networkChoice -like "*mainnet*") { "mainnet" } else { "testnet" }
    Divider-ML
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 2 — Passwords
# ─────────────────────────────────────────────────────────────────────────────
$useRandom = 'yes'
if ($script:NonInteractive) {
    Step-ML "Passwords"
    $NodeRpcPassword   = New-RandomPassword
    $WalletRpcPassword = New-RandomPassword
    Ok-ML "Generated random passwords (saved to .env)"
    $NodeRpcUsername   = "node_user"
    $WalletRpcUsername = "wallet_user"
    Divider-ML
} else {
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
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 3 — Web UI access (password + TOTP 2FA)
# ─────────────────────────────────────────────────────────────────────────────
if ($script:NonInteractive) {
    Step-ML "Web UI access"
    if ($env:WEB_UI_PASSWORD) {
        $UiPassword = $env:WEB_UI_PASSWORD
        if ($UiPassword.Length -lt 8) {
            Die-ML "WEB_UI_PASSWORD is set but shorter than 8 characters."
        }
        Ok-ML "Using WEB_UI_PASSWORD from environment"
    } else {
        $UiPassword = New-RandomPassword
        Ok-ML "Generated random web UI password (printed once in the summary below)"
    }
    Hint-ML "Hashing password (this may take a moment)..."
    $UiPasswordHash = New-PasswordHash -Password $UiPassword
    Ok-ML "Password hashed"
    $UiTotpSecret  = New-TotpSecret
    $SessionSecret = New-SessionSecret
    $TotpUri       = "otpauth://totp/Mintlayer%20GUI-X?secret=${UiTotpSecret}&issuer=Mintlayer"
    Ok-ML "TOTP secret generated"
    Hint-ML "TOTP secret will be written to mintlayer-totp.txt (not shown on screen)"
    Divider-ML
} else {
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
    $TotpUri       = "otpauth://totp/Mintlayer%20GUI-X?secret=${UiTotpSecret}&issuer=Mintlayer"

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
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 4 — HTTPS / Public access
# ─────────────────────────────────────────────────────────────────────────────
$httpsSetup = 'no'; $Domain = ''; $DuckdnsSubdomain = ''; $DuckdnsToken = ''
if ($script:NonInteractive) {
    Step-ML "HTTPS / Public access"
    Ok-ML "Skipped (non-interactive) — configure later by re-running the wizard or editing .env"
    Divider-ML
} else {
    Step-ML "HTTPS / Public access"
    Hint-ML "Caddy can automatically provision a free TLS certificate (Let's Encrypt)"
    Hint-ML "so the GUI is served over HTTPS — recommended for internet-facing servers."
    Hint-ML ""
    $httpsSetup = Confirm-ML "Set up HTTPS with automatic TLS certificate?" 'N'

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
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 5 — Indexer
# ─────────────────────────────────────────────────────────────────────────────
$enableIndexer = 'yes'
if ($script:NonInteractive) {
    Step-ML "Indexer stack"
    $PostgresPassword = New-RandomPassword
    Ok-ML "Indexer enabled (default) — random PostgreSQL password generated"
    Divider-ML
} else {
    Step-ML "Indexer stack"
    Hint-ML "The indexer adds PostgreSQL + blockchain scanner + REST API."
    Hint-ML "It enables Token Management and Trading in the web UI."
    Hint-ML "Requires more disk space and memory."
    Hint-ML ""
    $enableIndexer = Confirm-ML "Enable the indexer? (disable only if you don't need Token Management or Trading)" 'Y'
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
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 6 — IPFS Storage (optional)
# ─────────────────────────────────────────────────────────────────────────────
$IpfsProvider = ''; $FilebaseToken = ''; $PinataJwt = ''
if ($script:NonInteractive) {
    Step-ML "IPFS Storage (optional)"
    Ok-ML "Skipped (non-interactive) — configure later in the web UI Settings page"
    Divider-ML
} else {
    Step-ML "IPFS Storage (optional)"
    Hint-ML "Enables automatic upload of token/NFT images and metadata to IPFS."
    Hint-ML "Without this, URLs can still be entered manually — configure later in Settings."
    Hint-ML ""
    $setupIpfs = Confirm-ML "Configure IPFS now?" 'N'
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
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 7 — Telegram Notifications (optional)
# ─────────────────────────────────────────────────────────────────────────────
$TelegramBotToken = ''; $TelegramChatId = ''
if ($script:NonInteractive) {
    Step-ML "Telegram Notifications (optional)"
    Ok-ML "Skipped (non-interactive) — configure later in the web UI Settings page"
    Divider-ML
} else {
    Step-ML "Telegram Notifications (optional)"
    Hint-ML "Receive wallet alerts via a Telegram bot. Configure later in Settings."
    Hint-ML ""
    $setupTelegram = Confirm-ML "Configure Telegram notifications now?" 'N'
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
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 8 — Windows Firewall (wizard + admin only)
# ─────────────────────────────────────────────────────────────────────────────
$P2pPort = if ($Network -eq 'mainnet') { 3031 } else { 13031 }
$setupFirewall = 'no'; $openP2pPort = 'no'
if ($script:NonInteractive) {
    Ok-ML "Firewall: left unchanged (non-interactive) — the default stack needs zero inbound ports"
} else {
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
}

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
Step-ML "Summary"
Write-Host "${CYAN}│${RESET}"
$guiUrl = if ($httpsSetup -eq 'yes' -and $Domain) { "https://$Domain" } else { "http://localhost:4321" }
Write-Host "${CYAN}│${RESET}  $("Network:".PadRight(22)) ${BOLD}$Network${RESET}"
Write-Host "${CYAN}│${RESET}  $("Passwords:".PadRight(22)) ${BOLD}$(if ($useRandom -eq 'yes') {'randomly generated'} else {'custom'})${RESET}"
Write-Host "${CYAN}│${RESET}  $("Web UI auth:".PadRight(22)) ${BOLD}password + TOTP 2FA${RESET}"
Write-Host "${CYAN}│${RESET}  $("Web GUI:".PadRight(22)) ${BOLD}$guiUrl${RESET}"
Write-Host "${CYAN}│${RESET}  $("Indexer:".PadRight(22)) ${BOLD}$(if ($enableIndexer -eq 'yes') {'enabled — Token Management + Trading active'} else {'disabled — Token Management + Trading hidden'})${RESET}"
Write-Host "${CYAN}│${RESET}  $("IPFS storage:".PadRight(22)) ${BOLD}$(if ($IpfsProvider) {$IpfsProvider} else {'disabled — configure later in Settings'})${RESET}"
Write-Host "${CYAN}│${RESET}  $("Telegram:".PadRight(22)) ${BOLD}$(if ($TelegramBotToken) {'configured'} else {'disabled — configure later in Settings'})${RESET}"
Write-Host "${CYAN}│${RESET}"

if ($script:NonInteractive) {
    Write-Host "${CYAN}│${RESET}  ${BOLD}Web UI password: ${RESET}$UiPassword"
    Write-Host "${CYAN}│${RESET}  $("TOTP secret:".PadRight(22)) written to $(Join-Path $script:InstallDir 'mintlayer-totp.txt') (never shown on screen)"
    Write-Host "${CYAN}│${RESET}"
    Warn-ML "Save the web UI password now — it is printed only this once."
    Write-Host "${CYAN}│${RESET}"
    $proceed = 'yes'
} else {
    $proceed = Confirm-ML "Write .env and continue?" 'Y'
}
if ($proceed -ne 'yes') {
    Write-Host ""
    Warn-ML "Setup cancelled. Nothing was written."
    Exit-ML 0
}
Divider-ML

# ─────────────────────────────────────────────────────────────────────────────
# Write .env
# ─────────────────────────────────────────────────────────────────────────────
$MlUserId  = 1000; $MlGroupId = 1000
if ($script:NonInteractive) {
    if ($env:ML_USER_ID) {
        if ($env:ML_USER_ID -notmatch '^\d+$') { Die-ML "ML_USER_ID must be a positive integer (got '$($env:ML_USER_ID)')." }
        $MlUserId  = [int]$env:ML_USER_ID
    }
    if ($env:ML_GROUP_ID) {
        if ($env:ML_GROUP_ID -notmatch '^\d+$') { Die-ML "ML_GROUP_ID must be a positive integer (got '$($env:ML_GROUP_ID)')." }
        $MlGroupId = [int]$env:ML_GROUP_ID
    }
}
if ($MlUserId  -lt 1000) { $MlUserId  = 1000 }
if ($MlGroupId -lt 1000) { $MlGroupId = 1000 }

$IndexerEnabled = if ($enableIndexer -eq 'yes') { 'true' } else { 'false' }
$EnableHttps    = if ($httpsSetup -eq 'yes') { 'true' } else { 'false' }
$WalletRpcCmd   = "wallet-rpc-daemon $Network"

$envContent = @"
# Generated by windows.ps1 on $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
# ─────────────────────────────────────────

# Network: mainnet | testnet
NETWORK=$Network

# Docker user/group IDs
ML_USER_ID=$MlUserId
ML_GROUP_ID=$MlGroupId

# wallet-rpc-daemon command (network only — wallet files are managed via the web UI)
WALLET_RPC_CMD=$WalletRpcCmd

# Node RPC credentials
NODE_RPC_USERNAME=$NodeRpcUsername
NODE_RPC_PASSWORD=$NodeRpcPassword

# Wallet RPC credentials
WALLET_RPC_USERNAME=$WalletRpcUsername
WALLET_RPC_PASSWORD=$WalletRpcPassword

# Indexer-dependent features (Token Management, Trading)
INDEXER_ENABLED=$IndexerEnabled

# Session signing secret (generated by windows.ps1)
SESSION_SECRET=$SessionSecret

# Rust log level
RUST_LOG=info

# Indexer stack (only used with --profile indexer)
POSTGRES_USER=mintlayer
POSTGRES_PASSWORD=$PostgresPassword
POSTGRES_DB=mintlayer

# HTTPS via Caddy (only used with --profile https)
ENABLE_HTTPS=$EnableHttps
DOMAIN=$Domain
DUCKDNS_SUBDOMAIN=$DuckdnsSubdomain
DUCKDNS_TOKEN=$DuckdnsToken
"@
Write-Utf8 (Join-Path $script:InstallDir '.env') $envContent
Ok-ML ".env written"

# ── Non-interactive: persist TOTP secret to a file instead of stdout ─────────
if ($script:NonInteractive) {
    $totpFile = Join-Path $script:InstallDir 'mintlayer-totp.txt'
    $totpContent = @"
Mintlayer Web GUI — TOTP 2FA setup (generated $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
──────────────────────────────────────────────────────
Before your first login, add this secret to your
authenticator app (Google Authenticator, Authy, ...):

  Secret: $UiTotpSecret

Or paste this URI into https://qr.io to generate a QR code:

  $TotpUri

This file contains a secret. Delete it after setup:
  Remove-Item "$totpFile"
"@
    Write-Utf8 $totpFile $totpContent
    Ok-ML "TOTP setup file written: $totpFile"
}

# ── Write credentials to SQLite via temporary alpine container ────────────────
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

# ─────────────────────────────────────────────────────────────────────────────
# Start services
# ─────────────────────────────────────────────────────────────────────────────
Write-Host "${CYAN}│${RESET}"
$start = 'yes'
if (-not $script:NonInteractive) {
    $start = Confirm-ML "Start services now with docker compose?" 'Y'
}

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

# ─────────────────────────────────────────────────────────────────────────────
# Apply firewall rules
# ─────────────────────────────────────────────────────────────────────────────
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

# ─────────────────────────────────────────────────────────────────────────────
# Desktop & Start Menu shortcuts (wizard only)
# ─────────────────────────────────────────────────────────────────────────────
if (-not $script:NonInteractive) {
    $createShortcuts = Confirm-ML "Create Desktop and Start Menu shortcuts?" 'Y'
    if ($createShortcuts -eq 'yes') {
        $iconPath = Join-Path $script:InstallDir 'mintlayer.ico'
        try {
            $iconB64 = (Invoke-WebRequest -UseBasicParsing -Uri 'https://get.mintlayer.org/favicon.ico').Content
            if ($iconB64 -is [byte[]]) { [System.IO.File]::WriteAllBytes($iconPath, $iconB64) }
        } catch {
            # Icon is cosmetic — a missing file just falls back to the default icon
        }

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
}

Divider-ML

# ─────────────────────────────────────────────────────────────────────────────
# Done
# ─────────────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "${GREEN}${BOLD}  Setup complete!${RESET}"
Write-Host ""

if ($script:NonInteractive) {
    Write-Host "  ${BOLD}Next steps${RESET}"
    Write-Host ""
    Write-Host "  ${YELLOW}1.${RESET} Verify:  ${CYAN}docker compose ps${RESET}   (from $($script:InstallDir))"
    Write-Host "  ${YELLOW}2.${RESET} Web UI:  ${CYAN}http://localhost:4321${RESET}  (bound to 127.0.0.1 only)"
    Write-Host "  ${YELLOW}3.${RESET} Hand the web UI password and mintlayer-totp.txt to the operator"
    Write-Host ""
    Write-Host "  ${DIM}Note: mainnet sync takes hours on first run.${RESET}"
    Write-Host ""
    Exit-ML 0
}

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
Exit-ML 0
