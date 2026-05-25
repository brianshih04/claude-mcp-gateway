#!/usr/bin/env node
// mcp-gateway.js v3 — Unified MCP HTTP Gateway for Claude Desktop 3P
// Supports BOTH SSE transport (GET /sse + POST /messages) AND Streamable HTTP (POST /)
// NDJSON stdio to child MCP servers

var http = require("http");
var spawn = require("child_process").spawn;
var path = require("path");
var fs = require("fs");

var PORT = 59347;
var USERPROFILE = process.env.USERPROFILE || "C:\\Users\\Brian";
var LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(USERPROFILE, "AppData", "Local");
var NPM_MODS = path.join(
  process.env.APPDATA || path.join(USERPROFILE, "AppData", "Roaming"),
  "npm", "node_modules"
);

var ENTRIES = {
  memory: path.join(NPM_MODS, "@modelcontextprotocol/server-memory/dist/index.js"),
  filesystem: path.join(NPM_MODS, "@modelcontextprotocol/server-filesystem/dist/index.js"),
  fetch: path.join(NPM_MODS, "mcp-fetch-server/dist/index.js"),
  sequentialthinking: path.join(NPM_MODS, "mcp-sequential-thinking/dist/index.js"),
};

var nodeBin = process.execPath;
var LOG_FILE = path.join(LOCALAPPDATA, "mcp-powershell", "debug-gateway.log");

function log(msg) {
  var ts = new Date().toISOString();
  var line = "[" + ts + "] " + msg;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (e) {}
}

// ==================== StdioClient ====================
function StdioClient(serverName, entryJs, args, opts) {
  this.serverName = serverName;
  this.initialized = false;
  this.tools = [];
  this.reqId = 0;
  this.pending = new Map();
  this.partialLine = "";
  var self = this;

  log("[" + serverName + "] Spawning: " + nodeBin + " " + entryJs);
  this.proc = spawn(nodeBin, [entryJs].concat(args || []), {
    cwd: (opts && opts.cwd) || USERPROFILE,
    env: Object.assign({}, process.env, (opts && opts.env) || {}),
    stdio: ["pipe", "pipe", "pipe"],
  });

  this.proc.on("error", function(err) { log("[" + self.serverName + "] spawn error: " + err.message); });
  this.proc.on("exit", function(code) { log("[" + self.serverName + "] exited (" + code + ")"); });
  this.proc.stderr.on("data", function(d) {
    var s = d.toString().trim();
    if (s) log("[" + self.serverName + "] stderr: " + s.slice(0, 300));
  });
  this.proc.stdout.on("data", function(d) {
    var chunk = d.toString("utf8");
    self.partialLine += chunk;
    var lines = self.partialLine.split("\n");
    self.partialLine = lines.pop();
    for (var i = 0; i < lines.length; i++) {
      var trimmed = lines[i].trim();
      if (!trimmed) continue;
      try { self._onMsg(JSON.parse(trimmed)); }
      catch (e) { log("[" + self.serverName + "] parse err: " + trimmed.slice(0, 100)); }
    }
  });
}

StdioClient.prototype._send = function(msg) {
  if (!this.proc.stdin.writable) return;
  this.proc.stdin.write(JSON.stringify(msg) + "\n", "utf8");
};

StdioClient.prototype._onMsg = function(msg) {
  if (msg.id != null && this.pending.has(msg.id)) {
    var entry = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    entry.resolve(msg);
  }
};

StdioClient.prototype._request = function(method, params, skipInit) {
  if (!this.initialized && !skipInit) return Promise.resolve(null);
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
    clientInfo: { name: "mcp-gateway", version: "1.0.0" }
  }, true).then(function(r) {
    if (r) {
      self.initialized = true;
      self._send({ jsonrpc: "2.0", method: "notifications/initialized" });
      log("[" + self.serverName + "] initialized");
    }
    return r;
  });
};

StdioClient.prototype.loadTools = function() {
  var self = this;
  return this._request("tools/list", {}).then(function(r) {
    if (r && r.result && r.result.tools) {
      self.tools = r.result.tools;
      log("[" + self.serverName + "] " + self.tools.length + " tools");
    }
    return self.tools;
  });
};

StdioClient.prototype.callTool = function(name, args) {
  return this._request("tools/call", { name: name, arguments: args });
};

StdioClient.prototype.destroy = function() { if (this.proc) this.proc.kill(); };

// ==================== PowerShell ====================
function execPowershell(command, timeoutSec) {
  timeoutSec = timeoutSec || 30;
  return new Promise(function(resolve) {
    var proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      cwd: USERPROFILE, timeout: Math.min(timeoutSec, 120) * 1000
    });
    var stdout = "", stderr = "";
    proc.stdout.on("data", function(d) { stdout += d.toString("utf8"); });
    proc.stderr.on("data", function(d) { stderr += d.toString("utf8"); });
    proc.on("close", function(code) {
      resolve({
        content: [{ type: "text", text: (stdout + (stderr ? "\n[stderr] " + stderr : "")).trim() || "(exit " + code + ")" }],
        isError: code !== 0
      });
    });
    proc.on("error", function(err) {
      resolve({ content: [{ type: "text", text: "Error: " + err.message }], isError: true });
    });
  });
}

// ==================== Gateway State ====================
var sseRes = null;  // Active SSE response object for pushing events
var clients = [];
var toolMap = {};
var allTools = [];
var sessionId = "mcp-gw-" + Date.now();

function addServer(name, entryJs, args, opts) {
  clients.push({ name: name, entryJs: entryJs, args: args, opts: opts });
}

// ==================== JSON-RPC Handler ====================
function handleJsonRpc(msg, callback) {
  var id = msg.id;
  var method = msg.method;
  var params = msg.params || {};

  log("RPC " + method + " id=" + id);

  if (method === "initialize") {
    return callback({
      jsonrpc: "2.0", id: id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "mcp-gateway", version: "1.0.0" }
      }
    });
  }

  if (method === "notifications/initialized") {
    return callback(null); // 202 Accepted
  }

  if (method === "tools/list") {
    return callback({ jsonrpc: "2.0", id: id, result: { tools: allTools } });
  }

  if (method === "tools/call") {
    var toolName = params.name;
    log("call: " + toolName);
    var mapping = toolMap[toolName];
    if (!mapping) {
      return callback({ jsonrpc: "2.0", id: id, error: { code: -32601, message: "Unknown tool: " + toolName } });
    }
    if (mapping.type === "powershell") {
      var cmd = params.arguments && params.arguments.command;
      var timeout = (params.arguments && params.arguments.timeout) || 30;
      execPowershell(cmd, timeout).then(function(result) {
        callback({ jsonrpc: "2.0", id: id, result: result });
      }).catch(function(e) {
        callback({ jsonrpc: "2.0", id: id, error: { code: -32700, message: e.message } });
      });
      return;
    }
    mapping.client.callTool(mapping.origName, params.arguments || {}).then(function(r) {
      if (!r) {
        callback({ jsonrpc: "2.0", id: id, error: { code: -32603, message: "No response from server" } });
      } else {
        callback({ jsonrpc: "2.0", id: id, result: r.result || r });
      }
    }).catch(function(e) {
      callback({ jsonrpc: "2.0", id: id, error: { code: -32700, message: e.message } });
    });
    return;
  }

  callback({ jsonrpc: "2.0", id: id, error: { code: -32601, message: "Unknown method: " + method } });
}

// ==================== Startup ====================
var memDir = path.join(LOCALAPPDATA, "mcp-memory");
if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });

var fsDirs = [
  USERPROFILE,
  path.join(USERPROFILE, "Desktop"),
  path.join(USERPROFILE, "Documents"),
  path.join(USERPROFILE, "Downloads"),
].filter(function(p) { try { fs.accessSync(p); return true; } catch(e) { return false; } });

addServer("memory", ENTRIES.memory, [], { cwd: memDir });
// DISABLED: addServer("filesystem", ENTRIES.filesystem, fsDirs, {});
addServer("fetch", ENTRIES.fetch, [], {});
addServer("sequentialthinking", ENTRIES.sequentialthinking, [], []);

// Init all servers sequentially
function initServers() {
  var chain = Promise.resolve();
  clients.forEach(function(cfg) {
    chain = chain.then(function() {
      var client = new StdioClient(cfg.name, cfg.entryJs, cfg.args, cfg.opts);
      cfg.client = client;
      return client.init().then(function(r) {
        if (!r) {
          log("[" + cfg.name + "] retry in 3s...");
          return new Promise(function(resolve) { setTimeout(resolve, 3000); }).then(function() {
            return client.init();
          });
        }
        return r;
      }).then(function(r) {
        if (!r) { log("[" + cfg.name + "] failed"); return; }
        return client.loadTools().then(function(tools) {
          tools.forEach(function(t) {
            var pName = cfg.name + "__" + t.name;
            toolMap[pName] = { client: client, origName: t.name };
            allTools.push(Object.assign({}, t, {
              name: pName,
              description: "[" + cfg.name + "] " + t.description
            }));
          });
        });
      }).catch(function(e) {
        log("[" + cfg.name + "] err: " + (e && e.message));
      });
    });
  });
  return chain;
}

// Add PowerShell tool
allTools.push({
  name: "powershell__powershell",
  description: "[powershell] Execute a PowerShell command on Windows.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "PowerShell command" },
      timeout: { type: "number", description: "Timeout seconds (default 30)" }
    },
    required: ["command"]
  }
});
toolMap["powershell__powershell"] = { type: "powershell" };

// ==================== HTTP Server ====================
initServers().then(function() {
  log("\nGateway ready: " + allTools.length + " tools");

  var server = http.createServer(function(req, res) {
    log("HTTP " + req.method + " " + req.url);

    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

    // === SSE Transport (Claude Desktop old-style) ===
    // GET /sse — establish SSE stream, client POSTs to /messages
    if (req.method === "GET" && (req.url === "/sse" || req.url === "/")) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Mcp-Session-Id": sessionId
      });
      sseRes = res;
      res.write(": mcp-gateway connected\n\n");
      res.write("event: endpoint\ndata: /messages?sessionId=" + sessionId + "\n\n");
      log("SSE stream opened");
      var keepAlive = setInterval(function() {
        try { res.write(": ping\n\n"); } catch(e) { clearInterval(keepAlive); }
      }, 15000);
      req.on("close", function() { clearInterval(keepAlive); sseRes = null; log("SSE stream closed"); });
      return;
    }

    // === POST /messages (SSE transport message endpoint) ===
    if (req.method === "POST" && req.url.indexOf("/messages") >= 0) {
      var body = "";
      req.on("data", function(c) { body += c; });
      req.on("end", function() {
        try {
          var msg = JSON.parse(body);
          log("MSG: " + (msg.method || "response") + " id=" + msg.id);
          handleJsonRpc(msg, function(response) {
            if (!response) { res.writeHead(202); res.end(); return; }
            if (sseRes) {
              // Push result via SSE event stream
              sseRes.write("event: message\ndata: " + JSON.stringify(response) + "\n\n");
              res.writeHead(202, { "Mcp-Session-Id": sessionId });
              res.end();
            } else {
              res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": sessionId });
              res.end(JSON.stringify(response));
            }
          });
        } catch(e) {
          log("MSG parse err: " + e.message);
          res.writeHead(400); res.end("bad json");
        }
      });
      return;
    }

    // === Streamable HTTP (POST /) ===
    if (req.method === "POST") {
      var body2 = "";
      req.on("data", function(c) { body2 += c; });
      req.on("end", function() {
        try {
          var msg2 = JSON.parse(body2);
          log("POST body: " + body2.slice(0, 200));
          handleJsonRpc(msg2, function(response) {
            if (!response) { res.writeHead(202); res.end(); return; }
            res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": sessionId });
            res.end(JSON.stringify(response));
          });
        } catch(e) {
          log("POST parse err: " + e.message);
          res.writeHead(400); res.end("bad json");
        }
      });
      return;
    }

    // DELETE /session (session termination)
    if (req.method === "DELETE") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, result: {} }));
      return;
    }

    res.writeHead(405);
    res.end("method not allowed");
  });

  server.on("error", function(err) {
    if (err.code === "EADDRINUSE") { log("FATAL: port " + PORT + " in use"); process.exit(1); }
  });
  server.listen(PORT, "127.0.0.1", function() {
    log("Listening on http://127.0.0.1:" + PORT);
  });
});
