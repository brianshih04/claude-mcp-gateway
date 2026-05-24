#!/usr/bin/env node
// mcp-gateway.js — Unified MCP HTTP Gateway for Claude Desktop 3P
// Aggregates Memory + Filesystem + Fetch + Sequential Thinking + PowerShell
// Transport: HTTP (Streamable JSON-RPC) ← Claude Desktop | NDJSON stdio ← MCP servers
// Port: 59347 | Protocol: MCP 2025-06-18 | Encoding: NDJSON (NOT Content-Length)

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// === Configuration ===
const PORT = parseInt(process.env.MCP_GATEWAY_PORT, 10) || 59347;
const USERPROFILE = process.env.USERPROFILE || path.join("C:", "Users", process.env.USERNAME || "User");
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(USERPROFILE, "AppData", "Local");
const APPDATA = process.env.APPDATA || path.join(USERPROFILE, "AppData", "Roaming");
const NPM_MODS = path.join(APPDATA, "npm", "node_modules");

// Entry points for MCP servers (bypass .cmd wrappers — use node directly)
const ENTRIES = {
  memory: path.join(NPM_MODS, "@modelcontextprotocol", "server-memory", "dist", "index.js"),
  filesystem: path.join(NPM_MODS, "@modelcontextprotocol", "server-filesystem", "dist", "index.js"),
  fetch: path.join(NPM_MODS, "mcp-fetch-server", "dist", "index.js"),
  sequentialthinking: path.join(NPM_MODS, "mcp-sequential-thinking", "dist", "index.js"),
};

const nodeBin = process.execPath;
const LOG_DIR = path.join(LOCALAPPDATA, "mcp-powershell");
const LOG_FILE = path.join(LOG_DIR, "debug-gateway.log");

// === Logging ===
function log(msg) {
  var ts = new Date().toISOString();
  var line = "[" + ts + "] " + msg;
  console.log(line);
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (e) { /* ignore log write failures */ }
}

// === NDJSON Stdio Client ===
// MCP 2025-06-18 uses newline-delimited JSON (NOT Content-Length framing).
// Each message is: JSON.stringify(msg) + "\n"
// This was discovered by testing — official MCP servers silently ignore Content-Length framed messages.

var StdioClient = (function() {

  function StdioClient(serverName, entryJs, args, opts) {
    this.serverName = serverName;
    this.initialized = false;
    this.tools = [];
    this.reqId = 0;
    this.pending = new Map();
    this.partialLine = "";

    log("[" + serverName + "] Spawning: " + nodeBin + " " + entryJs + " " + args.join(" "));

    var self = this;
    this.proc = spawn(nodeBin, [entryJs].concat(args || []), {
      cwd: (opts && opts.cwd) || USERPROFILE,
      env: Object.assign({}, process.env, (opts && opts.env) || {}),
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.on("error", function(err) { log("[" + self.serverName + "] spawn error: " + err.message); });
    this.proc.on("exit", function(code) { log("[" + self.serverName + "] exited (" + code + ")"); });
    this.proc.stderr.on("data", function(d) {
      var s = d.toString().trim();
      if (s) log("[" + self.serverName + "] stderr: " + s.slice(0, 200));
    });

    // NDJSON parser: split on newlines, parse complete lines, buffer partial
    this.proc.stdout.on("data", function(d) {
      var chunk = d.toString("utf8");
      self.partialLine += chunk;
      var lines = self.partialLine.split("\n");
      self.partialLine = lines.pop(); // keep incomplete last line
      for (var i = 0; i < lines.length; i++) {
        var trimmed = lines[i].trim();
        if (!trimmed) continue;
        try { self._onMsg(JSON.parse(trimmed)); }
        catch (e) { log("[" + self.serverName + "] parse error: " + trimmed.slice(0, 100)); }
      }
    });
  }

  StdioClient.prototype._send = function(msg) {
    if (!this.proc.stdin.writable) return;
    var data = JSON.stringify(msg);
    this.proc.stdin.write(data + "\n", "utf8"); // NDJSON: JSON + newline
  };

  StdioClient.prototype._onMsg = function(msg) {
    if (msg.id != null && this.pending.has(msg.id)) {
      var entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      entry.resolve(msg.error ? null : msg.result);
    }
  };

  StdioClient.prototype._request = function(method, params, skipInitCheck) {
    if (!this.initialized && !skipInitCheck) return Promise.resolve(null);
    var self = this;
    var id = ++this.reqId;
    return new Promise(function(resolve) {
      var timer = setTimeout(function() {
        self.pending.delete(id);
        log("[" + self.serverName + "] timeout: " + method);
        resolve(null);
      }, 30000);
      self.pending.set(id, { resolve: resolve, timer: timer });
      self._send({ jsonrpc: "2.0", id: id, method: method, params: params });
    });
  };

  StdioClient.prototype.init = function() {
    var self = this;
    return this._request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-gateway", version: "2.0.0" }
    }, true).then(function(r) {
      if (r) {
        self.initialized = true;
        self._send({ jsonrpc: "2.0", method: "notifications/initialized" });
        log("[" + self.serverName + "] initialized: " + (r.serverInfo && r.serverInfo.name) + " v" + (r.serverInfo && r.serverInfo.version));
      }
      return r;
    });
  };

  StdioClient.prototype.loadTools = function() {
    var self = this;
    return this._request("tools/list", {}).then(function(r) {
      if (r && r.tools) {
        self.tools = r.tools;
        log("[" + self.serverName + "] " + self.tools.length + " tools: " + self.tools.map(function(t) { return t.name; }).join(", "));
      }
      return self.tools;
    });
  };

  StdioClient.prototype.callTool = function(name, args) {
    return this._request("tools/call", { name: name, arguments: args });
  };

  StdioClient.prototype.destroy = function() { if (this.proc) this.proc.kill(); };

  return StdioClient;
})();

// === PowerShell Executor ===
function execPowershell(command, timeoutSec) {
  timeoutSec = timeoutSec || 30;
  return new Promise(function(resolve) {
    var proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      cwd: USERPROFILE,
      timeout: Math.min(timeoutSec, 120) * 1000
    });
    var stdout = "", stderr = "";
    proc.stdout.on("data", function(d) { stdout += d.toString(); });
    proc.stderr.on("data", function(d) { stderr += d.toString(); });
    proc.on("close", function(code) {
      resolve({
        content: [{ type: "text", text: (stdout + (stderr ? "\n[stderr] " + stderr : "")).trim() || "(exit code: " + code + ")" }],
        isError: code !== 0
      });
    });
    proc.on("error", function(err) {
      resolve({ content: [{ type: "text", text: "Error: " + err.message }], isError: true });
    });
  });
}

// === Gateway ===
var PS_TOOLS = [{
  name: "powershell",
  description: "Execute a PowerShell command on Windows. Returns stdout and stderr.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "PowerShell command to execute" },
      timeout: { type: "number", description: "Timeout in seconds (default 30, max 120)" }
    },
    required: ["command"]
  }
}];

var gw = {
  clients: [],
  toolMap: {},
  allTools: [],

  addServer: function(name, entryJs, args, opts) {
    this.clients.push({ name: name, entryJs: entryJs, args: args || [], opts: opts || {} });
  },

  start: function() {
    var self = this;
    log("=== MCP Gateway v2.0 Starting ===");
    log("Node: " + nodeBin);
    log("Port: " + PORT);
    log("NPM modules: " + NPM_MODS);
    log("Log: " + LOG_FILE);
    log("Waiting 3s for MCP servers to spawn...");

    return new Promise(function(resolve) { setTimeout(resolve, 3000); }).then(function() {
      var chain = Promise.resolve();
      self.clients.forEach(function(cfg) {
        chain = chain.then(function() { return self._initServer(cfg); });
      });
      return chain;
    }).then(function() {
      // Add PowerShell tools
      PS_TOOLS.forEach(function(t) {
        self.toolMap[t.name] = { type: "powershell" };
        self.allTools.push(t);
      });

      log("\nGateway ready: " + self.allTools.length + " tools from " + (self.clients.length + 1) + " sources:");
      self.clients.forEach(function(cfg) {
        var count = self.allTools.filter(function(t) { return t.name.indexOf(cfg.name + "__") === 0; }).length;
        var status = (cfg.client && cfg.client.initialized) ? "\u2713" : "\u2717";
        log("  " + status + " " + cfg.name + ": " + count + " tools");
      });
      log("  \u2713 powershell: " + PS_TOOLS.length + " tools\n");
    });
  },

  _initServer: function(cfg) {
    var self = this;
    var client = new StdioClient(cfg.name, cfg.entryJs, cfg.args, cfg.opts);
    cfg.client = client;

    return client.init().then(function(r) {
      if (!r) {
        log("[" + cfg.name + "] init failed, retrying in 3s...");
        return new Promise(function(resolve) { setTimeout(resolve, 3000); }).then(function() {
          return client.init();
        });
      }
      return r;
    }).then(function(r) {
      if (!r) {
        log("[" + cfg.name + "] init failed again, skipping");
        return;
      }
      return client.loadTools().then(function(tools) {
        tools.forEach(function(t) {
          var pName = cfg.name + "__" + t.name;
          self.toolMap[pName] = { client: client, origName: t.name };
          self.allTools.push(Object.assign({}, t, {
            name: pName,
            description: "[" + cfg.name + "] " + t.description
          }));
        });
      });
    }).catch(function(e) {
      log("[" + cfg.name + "] error: " + (e && e.message) + " stack: " + ((e && e.stack) || "").slice(0, 300));
    });
  },

  callTool: function(name, args) {
    var self = this;
    var mapping = this.toolMap[name];
    if (!mapping) {
      return Promise.resolve({ content: [{ type: "text", text: "Unknown tool: " + name }], isError: true });
    }
    if (mapping.type === "powershell") {
      var cmd = args.command;
      var timeout = args.timeout || 30;
      delete args.command;
      delete args.timeout;
      return execPowershell(cmd, timeout);
    }
    return mapping.client.callTool(mapping.origName, args).then(function(r) {
      if (!r) return { content: [{ type: "text", text: "Server returned no response" }], isError: true };
      return r;
    });
  }
};

// === Configure sub-servers ===
var memDir = path.join(LOCALAPPDATA, "mcp-memory");
if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });

var fsDirs = [
  USERPROFILE,
  path.join(USERPROFILE, "Desktop"),
  path.join(USERPROFILE, "Documents"),
  path.join(USERPROFILE, "Downloads"),
].filter(function(p) { try { fs.accessSync(p); return true; } catch(e) { return false; } });

gw.addServer("memory", ENTRIES.memory, [], { cwd: memDir });
gw.addServer("filesystem", ENTRIES.filesystem, fsDirs, {});
gw.addServer("fetch", ENTRIES.fetch, [], {});
gw.addServer("sequentialthinking", ENTRIES.sequentialthinking, [], {});

// === Start HTTP server ===
gw.start().then(function() {
  var server = http.createServer(function(req, res) {
    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }

    var body = "";
    req.on("data", function(c) { body += c; });
    req.on("end", function() {
      try {
        var msg = JSON.parse(body);
        var id = msg.id;
        var method = msg.method;
        var params = msg.params;

        // Handle MCP protocol methods
        if (method === "initialize") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0", id: id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "mcp-gateway", version: "2.0.0" }
            }
          }));
          return;
        }
        if (method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
        if (method === "tools/list") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: id, result: { tools: gw.allTools } }));
          return;
        }
        if (method === "tools/call") {
          log("tools/call: " + (params && params.name));
          gw.callTool((params && params.name), (params && params.arguments) || {}).then(function(result) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: id, result: result }));
          }).catch(function(e) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: id, error: { code: -32700, message: e.message } }));
          });
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: id, error: { code: -32601, message: "Method not found: " + method } }));
      } catch (e) {
        log("HTTP error: " + e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: e.message } }));
      }
    });
  });

  server.on("error", function(err) {
    if (err.code === "EADDRINUSE") {
      log("FATAL: Port " + PORT + " already in use! Is another gateway running?");
      process.exit(1);
    }
  });

  server.listen(PORT, "127.0.0.1", function() {
    log("Listening on http://127.0.0.1:" + PORT);
  });
});
