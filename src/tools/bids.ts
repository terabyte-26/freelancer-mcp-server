import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiGet, apiPost, formatDate, mcpError, truncate, resolveAccountLabel, ACCOUNT_DESC } from "../services/api.js";
import { FreelancerBid, FreelancerProject } from "../types.js";
import { CHARACTER_LIMIT, DEFAULT_LIMIT, MAX_LIMIT } from "../constants.js";
import { bidGuard, recordBid, ledgerEnabled, allowanceFor, accountHealth, bidsToday, creditsFor } from "../services/ledger.js";

export function registerBidTools(server: McpServer): void {
  // Get bids on a project
  server.registerTool(
    "freelancer_get_project_bids",
    {
      title: "Get Project Bids",
      description: `List all bids on a specific Freelancer.com project.

Args:
  - project_id (number): The project ID to fetch bids for
  - limit (number, 1-50, default 10): Number of bids to return
  - offset (number, default 0): Pagination offset
  - account (string, optional): ${ACCOUNT_DESC}

Returns: list of bids with amount, period, bidder reputation and description

Use when: "Who has bid on project 12345?", "How much are people bidding?", "Show me the bids on my project"`,
      inputSchema: z.object({
        project_id: z.number().int().positive().describe("Numeric project ID"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe("Number of bids"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
        account: z.string().optional().describe(ACCOUNT_DESC),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project_id, limit, offset, account }) => {
      try {
        const result = await apiGet<{ bids: FreelancerBid[]; total_count: number }>(
          "/projects/0.1/bids",
          {
            "project_ids[]": project_id,
            limit,
            offset,
            reputation_details: true,
            bidder_details: true,
          },
          account
        );

        if (!result.bids?.length) {
          return { content: [{ type: "text", text: `No bids found for project ${project_id}.` }] };
        }

        const lines = [
          `**Bids on project ${project_id}** — ${result.total_count} total (showing ${result.bids.length}):`,
          "",
          ...result.bids.map((b, i) => formatBid(b, i + 1)),
        ];

        return {
          content: [{ type: "text", text: truncate(lines.join("\n"), CHARACTER_LIMIT) }],
          structuredContent: { total: result.total_count, bids: result.bids },
        };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    }
  );

  // Get my bids
  server.registerTool(
    "freelancer_my_bids",
    {
      title: "List My Bids",
      description: `List bids you have placed on Freelancer.com projects.

Args:
  - status (string, optional): Filter by bid status — "active", "awarded", "revoked", "rejected"
  - limit (number, 1-50, default 10): Number of bids to return
  - offset (number, default 0): Pagination offset
  - account (string, optional): ${ACCOUNT_DESC}

Returns: your bids with project info, amounts and status. To analyze your winning strategy, call this twice — once with status "awarded" and once with status "rejected" — and compare amount, period and proposal style across the two sets yourself.

Use when: "Show my bids", "Which of my bids are active?", "Have any of my bids been awarded?", "What's my win rate?", "Analyze my winning bids vs rejected ones"`,
      inputSchema: z.object({
        status: z.enum(["active", "awarded", "revoked", "rejected"]).optional().describe("Filter by bid status"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe("Number of results"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
        account: z.string().optional().describe(ACCOUNT_DESC),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ status, limit, offset, account }) => {
      try {
        const selfResult = await apiGet<{ id: number }>("/users/0.1/self", undefined, account);
        const selfId = selfResult.id;

        const params: Record<string, unknown> = {
          "bidder_ids[]": selfId,
          limit,
          offset,
          project_details: true,
        };
        if (status) params["statuses[]"] = status;

        const result = await apiGet<{ bids: FreelancerBid[]; total_count: number }>(
          "/projects/0.1/bids",
          params,
          account
        );

        if (!result.bids?.length) {
          return { content: [{ type: "text", text: "No bids found." }] };
        }

        const lines = [
          `**Your bids** — ${result.total_count} total (showing ${result.bids.length}):`,
          "",
          ...result.bids.map((b, i) => formatBid(b, i + 1)),
        ];

        return {
          content: [{ type: "text", text: truncate(lines.join("\n"), CHARACTER_LIMIT) }],
          structuredContent: { total: result.total_count, bids: result.bids },
        };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    }
  );

  // Credit / ledger status (from the auto-bid bot's database)
  server.registerTool(
    "freelancer_credit_status",
    {
      title: "Bid Credit Status",
      description: `What the auto-bid bot knows about an account's bid credits and health, read from its database (MONGO_URI): credits banked since the last BID_LIMIT_EXCEEDED, bids placed today, whether Freelancer marks the account as limited, and whether auto-bid is on. Call this BEFORE freelancer_place_bid when credits are scarce.

Args:
  - account (string, optional): ${ACCOUNT_DESC}

Returns: credits estimate, today's bids, plan, account health. Without MONGO_URI it says so.

Use when: "Do we have bid credits left?", "Can TeraByte26 bid right now?", "Is Hamza still limited?"`,
      inputSchema: z.object({ account: z.string().optional().describe(ACCOUNT_DESC) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ account }) => {
      try {
        const label = resolveAccountLabel(account);
        if (!ledgerEnabled()) {
          return { content: [{ type: "text", text: "MONGO_URI is not set on this server, so the bot's ledger is not available here." }] };
        }
        const [allowance, health, today] = await Promise.all([allowanceFor(label), accountHealth(label), bidsToday(label)]);
        const credits = await creditsFor(label, allowance);
        const lines = [
          `**${label} — bid credits**`,
          `Credits banked (ledger): ${credits === null ? "unknown (no bid limit seen yet)" : credits}`,
          allowance?.exhausted_at ? `Last BID_LIMIT_EXCEEDED: ${new Date(allowance.exhausted_at).toISOString().replace("T", " ").slice(0, 16)} UTC` : "",
          allowance ? `Plan: ${allowance.bid_limit ?? "?"} per ${String((allowance as { duration?: string }).duration || "month")} | credit interval ≈ ${Math.round(Number(allowance.interval_plan_s || allowance.interval_obs_s || 0) / 60)} min` : "",
          `Bids placed today: ${today ?? "?"}`,
          health ? `Account: ${health.enabled ? "auto-bid ON" : "auto-bid OFF"} | limited by Freelancer: ${health.limited === undefined ? "unknown" : health.limited ? "YES — bids refused" : "no"}` : "Account: not in the bot's registry",
        ].filter(Boolean);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: { account: label, credits, bids_today: today, allowance, health },
        };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    }
  );

  // Place a bid
  server.registerTool(
    "freelancer_place_bid",
    {
      title: "Place a Bid",
      description: `Submit a bid / proposal on a Freelancer.com project.

Before the bid goes out, when the server has MONGO_URI, the auto-bid bot's rules are applied: no second bid on a project the account already bid on, no bid from an account Freelancer marks as limited, no bid while the credit ledger says the account has no credit banked. A blocked bid returns the reasons instead of bidding; pass force=true only when you have decided to override them. Every attempt is recorded in the bot's my_bids (via "mcp") so the dashboard, pacing and dedup see it.

Args:
  - project_id (number): Project ID to bid on
  - amount (number): Your bid amount in the project's currency
  - period (number): Delivery time in days
  - description (string): Your proposal text (cover letter)
  - milestone_percentage (number, 0-100, default 100): Percentage to request as initial milestone
  - force (boolean, default false): Bid even when the bot's guard says no
  - account (string, optional): ${ACCOUNT_DESC} This is the account the bid is placed FROM.

Returns: confirmation with bid ID and status, plus the guard's notes

⚠️ This creates a real bid on your account and spends a bid credit. Review before confirming — including which account, when multiple are configured.

Use when: "Bid $150 on project 12345 with 7 days delivery", "Submit a proposal"`,
      inputSchema: z.object({
        project_id: z.number().int().positive().describe("Project ID to bid on"),
        amount: z.number().positive().describe("Bid amount in project currency"),
        period: z.number().int().positive().describe("Delivery time in days"),
        description: z.string().min(10).max(5000).describe("Proposal / cover letter text"),
        milestone_percentage: z.number().int().min(0).max(100).default(100).describe("Percentage to request as initial milestone (default 100)"),
        force: z.boolean().default(false).describe("Override the bot's credit / health / duplicate guard"),
        account: z.string().optional().describe(ACCOUNT_DESC + " This is the account the bid is placed FROM."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ project_id, amount, period, description, milestone_percentage, force, account }) => {
      let label: string;
      try {
        label = resolveAccountLabel(account);
      } catch (err) {
        return mcpError((err as Error).message);
      }
      const guard = await bidGuard(label, project_id);
      if (!guard.ok && !force) {
        return {
          content: [{
            type: "text",
            text: [
              `⛔ **Bid NOT placed** from ${label} on project ${project_id} — the bot's guard says no:`,
              ...guard.reasons.map((r) => `- ${r}`),
              ...guard.notes.map((n) => `- note: ${n}`),
              "",
              "Pass force=true to bid anyway (this spends a credit or gets refused by Freelancer).",
            ].join("\n"),
          }],
          structuredContent: { placed: false, guard },
          isError: true,
        };
      }
      // the project record, for the my_bids row (currency, budget, competition at bid time)
      let project: FreelancerProject | null = null;
      try {
        const r = await apiGet<{ projects: FreelancerProject[] }>("/projects/0.1/projects", { "projects[]": project_id, job_details: true }, label);
        project = r.projects?.[0] || null;
      } catch { /* the bid does not depend on it */ }
      try {
        const result = await apiPost<FreelancerBid>("/projects/0.1/bids", {
          project_id,
          amount,
          period,
          description,
          milestone_percentage,
        }, { account: label });
        let recorded: string | null = null;
        try {
          recorded = await recordBid({ account: label, projectId: project_id, amount, period, description, project, bid: result, status: "placed" });
        } catch (e) {
          guard.notes.push(`my_bids record failed: ${(e as Error).message}`);
        }
        return {
          content: [
            {
              type: "text",
              text: [
                `✅ **Bid placed successfully!**`,
                `Account: ${label}`,
                `Bid ID: ${result.id}`,
                `Project: ${project_id}${project?.title ? ` — ${project.title}` : ""}`,
                `Amount: ${amount}${project?.currency && (project.currency as { code?: string }).code ? " " + (project.currency as { code?: string }).code : ""} | Delivery: ${period} days`,
                `Status: ${result.status}`,
                `Submitted: ${formatDate(result.time_submitted)}`,
                recorded ? `Recorded in my_bids (${recorded}).` : "",
                ...guard.notes.map((n) => `note: ${n}`),
              ].filter(Boolean).join("\n"),
            },
          ],
          structuredContent: { placed: true, bid: result, guard, my_bids_id: recorded },
        };
      } catch (err) {
        const code = (err as Error & { code?: string }).code || null;
        try {
          await recordBid({ account: label, projectId: project_id, amount, period, description, project, status: "failed", errorCode: code });
        } catch { /* best effort */ }
        return mcpError(`${(err as Error).message}${code ? ` [${code}]` : ""}`);
      }
    }
  );
}

function formatBid(b: FreelancerBid, index: number): string {
  const bidder = b.bidder;
  return [
    `**${index}. Bid #${b.id}** — $${b.amount} / ${b.period} days`,
    `   Status: ${b.status} | Submitted: ${formatDate(b.time_submitted)}`,
    bidder ? `   Bidder: @${bidder.username} (${bidder.display_name}) ⭐ ${b.reputation?.overall?.toFixed(2) ?? "N/A"}` : "",
    b.description ? `   Proposal: ${b.description.slice(0, 200)}${b.description.length > 200 ? "..." : ""}` : "",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}
