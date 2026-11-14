import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listAccounts, accountEgress, egressIp, apiGet, mcpError, resolveAccountLabel, ACCOUNT_DESC } from "../services/api.js";
import { ledgerEnabled } from "../services/ledger.js";
import { pacingLimits } from "../services/pacing.js";

export function registerMetaTools(server: McpServer): void {
  server.registerTool(
    "freelancer_list_accounts",
    {
      title: "List Configured Accounts",
      description: `List the Freelancer.com account labels configured on this MCP server (never the tokens themselves), each with its egress (direct = this machine's IP, or the proxy host it is pinned to).

Use this to discover which \`account\` value to pass to other tools when multiple Freelancer profiles are connected.

Returns: account labels, egress per account, which one is the default, and whether the auto-bid bot's ledger is connected.

Use when: "Which Freelancer accounts are connected?", "Switch to the client2 account", "List my connected profiles"`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const accounts = listAccounts();
      if (!accounts.length) {
        return { content: [{ type: "text", text: "No accounts configured on this server." }] };
      }
      const { minGapS, dailyCap } = pacingLimits();
      const lines = [
        `**Configured accounts** (${accounts.length}):`,
        "",
        ...accounts.map((a, i) => `${i + 1}. \`${a}\` — egress: ${accountEgress(a)}${i === 0 ? " (default)" : ""}`),
        "",
        `Bot ledger (MONGO_URI): ${ledgerEnabled() ? "connected — place_bid is guarded and recorded" : "not connected"}`,
        `Message pacing: ${minGapS} s between messages, ${dailyCap || "no"} per day per account`,
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: {
          accounts: accounts.map((a) => ({ label: a, egress: accountEgress(a) })),
          default: accounts[0] ?? null,
          ledger: ledgerEnabled(),
          pacing: { min_gap_s: minGapS, daily_cap: dailyCap },
        },
      };
    }
  );

  server.registerTool(
    "freelancer_check_egress",
    {
      title: "Check Account Egress",
      description: `Verify an account end to end: the public IP its requests leave from (through its proxy when it has one) and whose token it carries (username from /users/0.1/self). Run it after adding an account or changing a proxy; two accounts must never report the same IP.

Args:
  - account (string, optional): ${ACCOUNT_DESC}

Returns: public IP, egress label, username and user id the token belongs to

Use when: "Which IP does Hamza use?", "Is the proxy working?", "Verify the accounts are isolated"`,
      inputSchema: z.object({ account: z.string().optional().describe(ACCOUNT_DESC) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ account }) => {
      try {
        const label = resolveAccountLabel(account);
        const [ip, self] = await Promise.all([
          egressIp(label).catch((e: Error) => `unavailable (${e.message})`),
          apiGet<{ id: number; username: string }>("/users/0.1/self", undefined, label),
        ]);
        return {
          content: [{ type: "text", text: `**${label}** — egress ${accountEgress(label)} → public IP ${ip} | token of @${self.username} (#${self.id})` }],
          structuredContent: { account: label, egress: accountEgress(label), ip, username: self.username, user_id: self.id },
        };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    }
  );
}
