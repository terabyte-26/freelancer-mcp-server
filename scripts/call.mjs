#!/usr/bin/env node
// Call ONE tool of the built server over MCP stdio and print its text result.
// Usage: node scripts/call.mjs <tool_name> '<json arguments>'   (env as for the server)
import { spawn } from "node:child_process";
import readline from "node:readline";

const [name, argsJson = "{}"] = process.argv.slice(2);
if (!name) { console.error("usage: call.mjs <tool_name> '<json arguments>'"); process.exit(2); }
const child = spawn(process.execPath, [new URL("../dist/index.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")], { stdio: ["pipe", "pipe", "inherit"] });
const rl = readline.createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const rpc = (method, params) => new Promise((resolve) => {
  const id = nextId++; pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "call", version: "0" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const r = await rpc("tools/call", { name, arguments: JSON.parse(argsJson) });
const out = (r.result?.content || []).map((c) => c.text).join("\n") || JSON.stringify(r.error || r, null, 2);
console.log(out);
child.kill();
process.exit(r.error || r.result?.isError ? 1 : 0);
