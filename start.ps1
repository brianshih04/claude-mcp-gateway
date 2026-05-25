<#
.SYNOPSIS
    Start MCP Gateway and inject enterprise config into Claude Desktop.
.DESCRIPTION
    This script is called by the scheduled task at logon and every 5 minutes.
    It starts the gateway if not running, and injects managedMcpServers +
    egress settings into Claude Desktop's enterprise config.
#>
param(
    [switch]$NoStart  # Skip gateway start (only inject config)
)

$ErrorActionPreference = "SilentlyContinue"
$Port = 59347
$GatewayDir = Join-Path $env:LOCALAPPDATA "mcp-powershell"
$GatewayJs = Join-Path $GatewayDir "mcp-gateway.js"

# ============================================================
# 1. Start Gateway
# ============================================================
if (-not $NoStart) {
    $running = $false
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $tcp.Connect("127.0.0.1", $Port)
        $tcp.Close()
        $running = $true
    } catch {}

    if (-not $running) {
        if (-not (Test-Path $GatewayJs)) {
            Write-Host "ERROR: $GatewayJs not found. Run install.ps1 first." -ForegroundColor Red
            exit 1
        }
        $nodeExe = (Get-Command node -ErrorAction Stop).Source
        Start-Process -FilePath $nodeExe -ArgumentList $GatewayJs -WindowStyle Hidden
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Started MCP Gateway on port $Port"
        # Wait for initialization
        Start-Sleep 15
    } else {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] MCP Gateway already running on port $Port"
    }
}

# ============================================================
# 2. Inject Enterprise Config
# ============================================================
$ConfigDir = Join-Path $env:LOCALAPPDATA "Claude-3p\configLibrary"
$MetaPath = Join-Path $ConfigDir "_meta.json"

if (-not (Test-Path $MetaPath)) {
    Write-Host "Claude-3p configLibrary not found. Is CC Switch set up?" -ForegroundColor Yellow
    exit 0
}

$Meta = Get-Content $MetaPath -Raw | ConvertFrom-Json
$ConfigId = $Meta.appliedId
if (-not $ConfigId) {
    Write-Host "No appliedId in _meta.json" -ForegroundColor Yellow
    exit 0
}

$ConfigPath = Join-Path $ConfigDir "$ConfigId.json"
if (-not (Test-Path $ConfigPath)) {
    Write-Host "Config not found: $ConfigPath" -ForegroundColor Yellow
    exit 0
}

$Config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
$Changed = $false

# Inject egress whitelist
if ($Config.coworkEgressAllowedHosts -notcontains "*") {
    $Config | Add-Member -NotePropertyName "coworkEgressAllowedHosts" -NotePropertyValue @("*") -Force
    $Changed = $true
    Write-Host "  + coworkEgressAllowedHosts: ['*']"
}

# Inject web search
if ($Config.coworkWebSearchEnabled -ne $true) {
    $Config | Add-Member -NotePropertyName "coworkWebSearchEnabled" -NotePropertyValue $true -Force
    $Changed = $true
    Write-Host "  + coworkWebSearchEnabled: true"
}

# Inject MCP server
$McpEntry = @{
    name      = "mcp-gateway"
    transport = "http"
    url       = "http://127.0.0.1:$Port"
    source    = "managed"
}
$CurrentMcp = $Config.managedMcpServers
$NeedMcp = $true
if ($CurrentMcp) {
    foreach ($entry in $CurrentMcp) {
        if ($entry.url -eq "http://127.0.0.1:$Port") {
            $NeedMcp = $false
            break
        }
    }
}
if ($NeedMcp) {
    $Config | Add-Member -NotePropertyName "managedMcpServers" -NotePropertyValue @($McpEntry) -Force
    $Changed = $true
    Write-Host "  + managedMcpServers: mcp-gateway (http://127.0.0.1:$Port)"
}

if ($Changed) {
    $json = $Config | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText($ConfigPath, $json, [System.Text.UTF8Encoding]::new($false))
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Enterprise config injected ($ConfigId)" -ForegroundColor Green
} else {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Enterprise config up-to-date ($ConfigId)"
}
