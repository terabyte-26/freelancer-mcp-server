#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initApiClients, AccountConfig } from "./services/api.js";
import { registerProfileTools } from "./tools/profile.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerBidTools } from "./tools/bids.js";
import { registerMilestoneTools } from "./tools/milestones.js";
import { registerMessageTools } from "./tools/messages.js";
import { registerAccountTools } from "./tools/account.js";
import { registerMetaTools } from "./tools/meta.js";

/**
 * Accounts can be configured two ways (either or both):
 *  - FREELANCER_OAUTH_TOKEN: a single token, registered under the label "default"
 *  - FREELANCER_ACCOUNTS: JSON object of label -> token, or label -> {token, proxy}
 *    e.g. {"main":"tok_abc","client_acme":{"token":"tok_def","proxy":"socks5h://user:pass@host:1080"}}
 * A proxy pins EVERY call of that account to that egress (two accounts should
 * never share one). Every tool takes an optional `account` argument.
 *
 * Optional:
 *  - MONGO_URI (+ MONGO_DB, default freelancer_analytics): the auto-bid bot's
 *    analytics database. When set, freelancer_place_bid consults the bot's
 *    credit ledger / account health / duplicate store before bidding and
 *    records the attempt in `my_bids` like the bot does.
 *  - MESSAGE_MIN_GAP_S (45) / MESSAGE_DAILY_CAP (80): pacing of outbound messages.
 */
function loadAccounts(): Record<string, AccountConfig> {
  const accounts: Record<string, AccountConfig> = {};

  const single = process.env.FREELANCER_OAUTH_TOKEN;
  if (single) accounts.default = { token: single, proxy: process.env.FREELANCER_PROXY || "" };

  const multi = process.env.FREELANCER_ACCOUNTS;
  if (multi) {
    try {
      const parsed = JSON.parse(multi);
      if (parsed && typeof parsed === "object") {
        for (const [label, value] of Object.entries(parsed)) {
          if (typeof value === "string" && value.length > 0) {
            accounts[label] = { token: value };
          } else if (value && typeof value === "object") {
            const v = value as { token?: unknown; proxy?: unknown };
            if (typeof v.token === "string" && v.token.length > 0) {
              accounts[label] = { token: v.token, proxy: typeof v.proxy === "string" ? v.proxy.trim() : "" };
            }
          }
        }
      }
    } catch {
      console.error(
        "Warning: FREELANCER_ACCOUNTS is not valid JSON. Expected format: " +
          '{"label1":"token1","label2":{"token":"token2","proxy":"http://user:pass@host:port"}}'
      );
    }
  }

  return accounts;
}

const accounts = loadAccounts();

if (Object.keys(accounts).length === 0) {
  console.error(
    "Error: no Freelancer accounts configured.\n" +
      "Set FREELANCER_OAUTH_TOKEN for a single account, or FREELANCER_ACCOUNTS " +
      '(JSON, e.g. {"main":"token1","client2":{"token":"token2","proxy":"..."}}) for multiple.\n' +
      "Get a Personal Access Token from: https://accounts.freelancer.com/settings/develop"
  );
  process.exit(1);
}

initApiClients(accounts);

const server = new McpServer({
  name: "freelancer-mcp-server",
  version: "2.1.0",
});

// Register all tool domains
registerMetaTools(server);
registerProfileTools(server);
registerProjectTools(server);
registerBidTools(server);
registerMilestoneTools(server);
registerMessageTools(server);
registerAccountTools(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const egress = Object.entries(accounts).map(([l, c]) => `${l}${c.proxy ? " (proxied)" : ""}`);
  console.error(
    `Freelancer MCP server running via stdio — ${egress.length} account(s) configured: ${egress.join(", ")}` +
      (process.env.MONGO_URI ? " — bot ledger connected" : " — no MONGO_URI: bid guard off")
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
