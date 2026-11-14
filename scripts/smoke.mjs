#!/usr/bin/env node
// Speak MCP (JSON-RPC over stdio) to a built server and exercise the read-only tools.
// Usage: FREELANCER_ACCOUNTS='{"main":"token"}' npm run smoke
import { spawn } from "node:child_process";
import readline from "node:readline";

const child = spawn(process.execPath, [new URL("../dist/index.js", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")], { stdio: ["pipe", "pipe", "inherit"] });
const rl = readline.createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
function rpc(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => pending.set(id, resolve));
}
function notify(method, params) { child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); }
const text = (r) => (r.result?.content || []).map((c) => c.text).join("\n") || JSON.stringify(r.error || r);

await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
notify("notifications/initialized");
const tools = (await rpc("tools/list", {})).result.tools;
console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(", "));
for (const [name, args] of [
  ["freelancer_list_accounts", {}],
  ["freelancer_check_egress", {}],
  ["freelancer_credit_status", {}],
  ["freelancer_list_threads", { limit: 3, unread_only: true }],
  ...(process.env.SMOKE_PROJECT_ID ? [["freelancer_place_bid", { project_id: Number(process.env.SMOKE_PROJECT_ID), amount: 100, period: 7, description: "smoke test: the duplicate guard must block this, nothing may be placed" }]] : []),
]) {
  const r = await rpc("tools/call", { name, arguments: args });
  console.log(`\n== ${name}\n${text(r).slice(0, 900)}`);
}
child.kill();
process.exit(0);
