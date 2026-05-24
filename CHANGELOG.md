# MCP Gateway Changelog

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
- Auto-recovery via Windows Scheduled Task (5-min interval)

### What's New vs. Previous Approach
- Replaced Content-Length framing with NDJSON (critical fix — official servers silently ignore CL)
- Replaced `.cmd` wrapper spawning with direct `node` entry point execution
- Added auto-recovery scheduled task (previously manual cron)
- Added `install.ps1` / `uninstall.ps1` for easy deployment
- Made paths portable using env vars (`USERPROFILE`, `LOCALAPPDATA`, `APPDATA`)
