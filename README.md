# Claude Desktop MCP Gateway

Unified MCP HTTP Gateway for Claude Desktop (3rd Party Provider mode). Gives Claude Desktop access to **31 extra tools** — Memory, Filesystem, Web Fetch, Sequential Thinking, and PowerShell — all through a single HTTP endpoint.

## Why?

Windows Store Claude Desktop runs in an AppX sandbox that blocks `child_process.spawn`, making it impossible to use stdio MCP servers directly. This gateway works around that by:

1. Spawning MCP servers as a standalone Node.js process (outside the sandbox)
2. Exposing them via HTTP (Streamable JSON-RPC) on `localhost`
3. Claude Desktop connects via HTTP — no sandbox issues

## Features

| MCP Server | Tools | What it does |
|---|---|---|
| **Memory** | 9 | Knowledge graph — entities, relations, observations |
| **Filesystem** | 14 | Read, write, search, move files |
| **Fetch** | 6 | Fetch web pages, YouTube transcripts, JSON APIs |
| **Sequential Thinking** | 1 | Structured multi-step reasoning |
| **PowerShell** | 1 | Execute Windows PowerShell commands |
| **Total** | **31** | |

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v18+ (`winget install OpenJS.NodeJS.LTS`)
- [Claude Desktop](https://claude.ai/download) (standalone or Windows Store v1.8555+)
- [CC Switch](https://ccswitch.io) configured with a 3rd Party provider (DeepSeek, z.ai, etc.)

### Install

```powershell
# 1. Clone this repo
git clone https://github.com/brianshih04/claude-mcp-gateway.git
cd claude-mcp-gateway

# 2. Run installer (installs MCP packages, creates scheduled task, injects config)
.\install.ps1
```

That's it — **almost**. There's one manual step in CC Switch:

### ⚠️ Enable MCP in CC Switch

1. Open CC Switch → click **Claude Desktop** in the sidebar
2. Find the **MCP Server** toggle and enable it
3. Fully quit Claude Desktop (taskbar icon → Quit)
4. Restart Claude Desktop
5. Click the 🔌 plug icon — you should see 31 new MCP tools

The toggle enables `isLocalDevMcpEnabled` in the enterprise config. Without it, Claude Desktop ignores `managedMcpServers` even if properly injected.

### Verify

```powershell
# Check gateway is running
Invoke-RestMethod -Uri "http://127.0.0.1:59347" -Method POST -ContentType "application/json" -Body '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | ConvertTo-Json -Depth 5
```

## Architecture

```
Claude Desktop (3P mode)
  │
  │ POST http://127.0.0.1:59347
  │ Streamable JSON-RPC
  ▼
mcp-gateway.js (Node.js HTTP server)
  ├── Memory ──────── NDJSON stdio ──→ server-memory
  ├── Filesystem ──── NDJSON stdio ──→ server-filesystem
  ├── Fetch ───────── NDJSON stdio ──→ mcp-fetch-server
  ├── Seq. Thinking ─ NDJSON stdio ──→ mcp-sequential-thinking
  └── PowerShell ──── direct spawn ──→ powershell.exe
```

## Configuration

### Filesystem Allowed Directories

Edit `mcp-gateway.js` to change which directories the Filesystem server can access:

```javascript
var fsDirs = [
  USERPROFILE,                              // User home
  path.join(USERPROFILE, "Desktop"),
  path.join(USERPROFILE, "Documents"),
  path.join(USERPROFILE, "Downloads"),
  // Add more directories here
].filter(function(p) { try { fs.accessSync(p); return true; } catch(e) { return false; } });
```

### Port

Default: `59347`. Change in `mcp-gateway.js` line 10 and `start.ps1`.

### Memory Storage

Default: `%LOCALAPPDATA%\mcp-memory\`. Change `memDir` in `mcp-gateway.js`.

## Scripts

| Script | Description |
|---|---|
| `install.ps1` | Full setup: install npm packages, copy gateway, create startup task, inject Claude Desktop config |
| `start.ps1` | Start gateway + inject config (called by scheduled task) |
| `uninstall.ps1` | Remove scheduled task, stop gateway, clean injected config |

## Manual Setup (without install.ps1)

```powershell
# 1. Install MCP server packages
npm install -g @modelcontextprotocol/server-memory @modelcontextprotocol/server-filesystem mcp-fetch-server mcp-sequential-thinking

# 2. Copy mcp-gateway.js to %LOCALAPPDATA%\mcp-powershell\
New-Item -ItemType Directory -Path "$env:LOCALAPPDATA\mcp-powershell" -Force
Copy-Item mcp-gateway.js "$env:LOCALAPPDATA\mcp-powershell\" -Force

# 3. Start gateway
Start-Process -FilePath (Get-Command node).Source -ArgumentList "$env:LOCALAPPDATA\mcp-powershell\mcp-gateway.js" -WindowStyle Hidden

# 4. Inject into Claude Desktop enterprise config
.\start.ps1

# 5. Restart Claude Desktop
```

## How It Works

### MCP 2025-06-18 NDJSON Transport

This gateway uses **newline-delimited JSON (NDJSON)** for stdio communication with MCP servers. The older MCP 2024-11-05 used Content-Length framing, which silently fails with current official servers. This was the key discovery that made the gateway work.

### Enterprise Config Injection

Claude Desktop in 3P mode reads MCP server definitions from the `managedMcpServers` field in its enterprise config (`configLibrary/<uuid>.json`). The gateway injects:

```json
{
  "managedMcpServers": [
    {
      "name": "mcp-gateway",
      "transport": "http",
      "url": "http://127.0.0.1:59347",
      "source": "managed"
    }
  ],
  "coworkEgressAllowedHosts": ["*"],
  "coworkWebSearchEnabled": true
}
```

This also unlocks WebFetch (unrestricted egress) and WebSearch in 3P mode.

### Auto-Recovery

The scheduled task runs `start.ps1` at every logon and every 5 minutes. This handles:
- Starting the gateway if it crashed
- Re-injecting enterprise config if CC Switch overwrote it

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Server is busy / parked for retry" | Gateway not running → run `.\start.ps1` |
| No MCP tools visible | CC Switch MCP toggle off → enable in CC Switch settings |
| 0 tools from gateway | npm packages not installed → `npm list -g --depth=0` |
| Egress/WebFetch broken | Config not injected → run `.\start.ps1` |
| MCP disappears after provider switch | CC Switch overwrites config → wait 5 min (auto-recovery) |

### Debug Log

```
%LOCALAPPDATA%\mcp-powershell\debug-gateway.log
```

## Requirements

| Dependency | Version | Why |
|---|---|---|
| Node.js | ≥ 18 | MCP server runtime |
| Claude Desktop | ≥ 1.8555 | 3P MCP support |
| CC Switch | ≥ 3.15 | 3P provider management |

## License

MIT

## Credits

- [MCP Servers](https://github.com/modelcontextprotocol/servers) by Anthropic
- [mcp-fetch-server](https://www.npmjs.com/package/mcp-fetch-server) by zcaceres
- [mcp-sequential-thinking](https://www.npmjs.com/package/mcp-sequential-thinking) by community
- [CC Switch](https://github.com/farion1231/cc-switch) by farion1231
