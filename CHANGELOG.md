# MCP Gateway Changelog

## v2.0.1 (2026-05-25)

### Fixed
- **BOM encoding bug** — PowerShell `Set-Content -Encoding UTF8` adds UTF-8 BOM (EF BB BF) to JSON config files, causing Claude Desktop to silently fail parsing `managedMcpServers`. Replaced with `[System.IO.File]::WriteAllText()` (UTF-8 without BOM) in both `start.ps1` and `install.ps1`
- **npm stderr crash** — `install.ps1` used `$ErrorActionPreference = "Stop"` which treats npm's deprecation warnings (written to stderr) as terminating errors, aborting the installer mid-way. Changed to `"Continue"`
- **Scheduled task only ran at logon** — CC Switch overwrites enterprise config on every provider switch. Added a 2-minute repeating trigger so the config gets re-injected automatically
- Removed incorrect "Enable the MCP server toggle in CC Switch" step from install instructions (no such toggle exists)

## v2.0.0 (2026-05-24)

### Initial Release
- Unified MCP HTTP Gateway aggregating 5 servers into 31 tools
- **Memory** (9 tools) — knowledge graph: entities, relations, observations
- **Filesystem** (14 tools) — read, write, search, move files
- **Fetch** (6 tools) — web pages, YouTube transcripts, JSON APIs
- **Sequential Thinking** (1 tool) — structured multi-step reasoning
- **PowerShell** (1 tool) — Windows command execution

### Key Technical Details
- MCP 2025-06-18 NDJSON stdio transport (not Content-Length framing)
- Direct `node` entry points bypassing .cmd wrappers
- Environment variable-based path detection (no hardcoded paths)
- Configurable via `MCP_GATEWAY_PORT` env var
- Auto-recovery via Windows Scheduled Task (2-min repeat)

### What's New vs. Previous Approach
- Replaced Content-Length framing with NDJSON (critical fix — official servers silently ignore CL)
- Replaced `.cmd` wrapper spawning with direct `node` entry point execution
- Added auto-recovery scheduled task (previously manual cron)
- Added `install.ps1` / `uninstall.ps1` for easy deployment
- Made paths portable using env vars (`USERPROFILE`, `LOCALAPPDATA`, `APPDATA`)
