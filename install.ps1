<#
.SYNOPSIS
    Install Claude Desktop MCP Gateway.
.DESCRIPTION
    Installs npm packages, copies gateway, creates scheduled task,
    injects Claude Desktop enterprise config. Run once per machine.
.EXAMPLE
    .\install.ps1
.EXAMPLE
    .\install.ps1 -Port 8080 -SkipNodeCheck
#>
param(
    [int]$Port = 59347,
    [switch]$SkipNodeCheck,
    [switch]$Uninstall
)

$ErrorActionPreference = "Continue"

# ============================================================
# Uninstall mode
# ============================================================
if ($Uninstall) {
    Write-Host "=== Uninstalling MCP Gateway ===" -ForegroundColor Cyan

    # Remove scheduled task
    Unregister-ScheduledTask -TaskName "MCP Gateway" -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "  - Removed scheduled task"

    # Kill gateway process
    $procs = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
    if ($procs) {
        $procs | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
        Write-Host "  - Stopped gateway process"
    }

    # Remove injected config
    $ConfigDir = Join-Path $env:LOCALAPPDATA "Claude-3p\configLibrary"
    $MetaPath = Join-Path $ConfigDir "_meta.json"
    if (Test-Path $MetaPath) {
        $Meta = Get-Content $MetaPath -Raw | ConvertFrom-Json
        $ConfigId = $Meta.appliedId
        if ($ConfigId) {
            $ConfigPath = Join-Path $ConfigDir "$ConfigId.json"
            if (Test-Path $ConfigPath) {
                $Config = Get-Content $ConfigPath -Raw | ConvertFrom-Json
                if ($Config.managedMcpServers) {
                    $Config.PSObject.Properties.Remove("managedMcpServers")
                    $json = $Config | ConvertTo-Json -Depth 5
                    [System.IO.File]::WriteAllText($ConfigPath, $json, [System.Text.UTF8Encoding]::new($false))
                    Write-Host "  - Removed managedMcpServers from enterprise config"
                }
            }
        }
    }

    # Remove gateway files
    $GatewayDir = Join-Path $env:LOCALAPPDATA "mcp-powershell"
    if (Test-Path $GatewayDir) {
        Remove-Item $GatewayDir -Recurse -Force
        Write-Host "  - Removed $GatewayDir"
    }

    Write-Host "`nUninstall complete. Restart Claude Desktop." -ForegroundColor Green
    exit 0
}

# ============================================================
# Prerequisites
# ============================================================
Write-Host "=== Claude Desktop MCP Gateway Installer ===" -ForegroundColor Cyan
Write-Host ""

# Check Node.js
if (-not $SkipNodeCheck) {
    try {
        $nodeVersion = & node --version 2>&1
        Write-Host "[OK] Node.js $nodeVersion" -ForegroundColor Green
    } catch {
        Write-Host "[FAIL] Node.js not found. Install with: winget install OpenJS.NodeJS.LTS" -ForegroundColor Red
        Write-Host "        Then re-run this script. Or use -SkipNodeCheck to skip." -ForegroundColor Yellow
        exit 1
    }
}

# Check Claude-3p config
$ConfigDir = Join-Path $env:LOCALAPPDATA "Claude-3p\configLibrary"
if (-not (Test-Path (Join-Path $ConfigDir "_meta.json"))) {
    Write-Host "[WARN] Claude-3p configLibrary not found." -ForegroundColor Yellow
    Write-Host "       Make sure CC Switch is installed and configured." -ForegroundColor Yellow
    Write-Host "       You can still install; config injection will be skipped." -ForegroundColor Yellow
}

# ============================================================
# Step 1: Install npm packages
# ============================================================
Write-Host ""
Write-Host "[1/4] Installing MCP server packages..." -ForegroundColor Cyan

$Packages = @(
    "@modelcontextprotocol/server-memory",
    "@modelcontextprotocol/server-filesystem",
    "mcp-fetch-server",
    "mcp-sequential-thinking"
)

foreach ($Pkg in $Packages) {
    $installed = npm list -g $Pkg --depth=0 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [OK] $Pkg (already installed)" -ForegroundColor DarkGray
    } else {
        Write-Host "  Installing $Pkg..." -ForegroundColor Gray
        npm install -g $Pkg 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  [OK] $Pkg" -ForegroundColor Green
        } else {
            Write-Host "  [FAIL] $Pkg — installation failed" -ForegroundColor Red
        }
    }
}

# ============================================================
# Step 2: Copy gateway files
# ============================================================
Write-Host ""
Write-Host "[2/4] Installing gateway..." -ForegroundColor Cyan

$GatewayDir = Join-Path $env:LOCALAPPDATA "mcp-powershell"
$DestGatewayJs = Join-Path $GatewayDir "mcp-gateway.js"
$DestStartPs1 = Join-Path $GatewayDir "start.ps1"

New-Item -ItemType Directory -Path $GatewayDir -Force | Out-Null

# Copy files from script directory
$ScriptDir = $PSScriptRoot
Copy-Item (Join-Path $ScriptDir "mcp-gateway.js") $DestGatewayJs -Force
Copy-Item (Join-Path $ScriptDir "start.ps1") $DestStartPs1 -Force

Write-Host "  [OK] Copied mcp-gateway.js to $GatewayDir" -ForegroundColor Green
Write-Host "  [OK] Copied start.ps1 to $GatewayDir" -ForegroundColor Green

# ============================================================
# Step 3: Create scheduled task
# ============================================================
Write-Host ""
Write-Host "[3/4] Creating scheduled task..." -ForegroundColor Cyan

# Remove existing task first
Unregister-ScheduledTask -TaskName "MCP Gateway" -Confirm:$false -ErrorAction SilentlyContinue

$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$DestStartPs1`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$TriggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 2)
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden -StartWhenAvailable -RestartInterval (New-TimeSpan -Minutes 5) -RestartCount 3
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName "MCP Gateway" -Action $Action -Trigger $Trigger,@($TriggerRepeat) -Settings $Settings -Principal $Principal -Description "Auto-start MCP Gateway for Claude Desktop (31 extra tools)" | Out-Null

Write-Host "  [OK] Scheduled task 'MCP Gateway' created" -ForegroundColor Green
Write-Host "       - Runs at logon" -ForegroundColor DarkGray
Write-Host "       - Runs at logon + every 2 min (auto-recovery)" -ForegroundColor DarkGray

# ============================================================
# Step 4: Start gateway + inject config
# ============================================================
Write-Host ""
Write-Host "[4/4] Starting gateway + injecting config..." -ForegroundColor Cyan

# Kill any existing gateway on our port
$existingPort = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
if ($existingPort) {
    $existingPort | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    Start-Sleep 2
}

# Start gateway
$nodeExe = (Get-Command node).Source
Start-Process -FilePath $nodeExe -ArgumentList $DestGatewayJs -WindowStyle Hidden
Write-Host "  Started gateway process" -ForegroundColor Green

# Wait for initialization
Write-Host "  Waiting 15s for MCP servers to initialize..." -ForegroundColor Gray
Start-Sleep 15

# Run start.ps1 to inject config
& $DestStartPs1 -NoStart

# ============================================================
# Verify
# ============================================================
Write-Host ""
Write-Host "=== Verification ===" -ForegroundColor Cyan

$VerifyBody = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
try {
    $Result = Invoke-RestMethod -Uri "http://127.0.0.1:$Port" -Method POST -ContentType "application/json" -Body $VerifyBody -TimeoutSec 10
    $ToolCount = $Result.result.tools.Count
    Write-Host "[OK] Gateway responding: $ToolCount tools available" -ForegroundColor Green

    # List tools by source
    $Sources = $Result.result.tools | ForEach-Object {
        if ($_.name -like "*__*") { $_.name.Split("__")[0] }
        else { $_.name }
    } | Group-Object | Sort-Object Count -Descending

    foreach ($src in $Sources) {
        Write-Host ("  {0,-20} {1,3} tools" -f $src.Name, $src.Count) -ForegroundColor DarkGray
    }
} catch {
    Write-Host "[WARN] Gateway not responding yet. Check log: $GatewayDir\debug-gateway.log" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=== Install Complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Make sure CC Switch is running with a 3P provider"
Write-Host "  2. Enable the MCP server toggle in CC Switch (Claude Desktop panel)"
Write-Host "  3. Fully quit and restart Claude Desktop"
Write-Host "  4. Click the plug icon to see MCP tools"
Write-Host ""
Write-Host "To uninstall: .\install.ps1 -Uninstall" -ForegroundColor DarkGray
