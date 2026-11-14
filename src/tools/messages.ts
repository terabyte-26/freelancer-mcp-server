import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiGet, apiPost, apiPut, formatDate, mcpError, truncate, resolveThreadId, resolveAccountLabel, ACCOUNT_DESC } from "../services/api.js";
import { FreelancerThread, FreelancerMessage, FreelancerUser } from "../types.js";
import { CHARACTER_LIMIT, DEFAULT_LIMIT, MAX_LIMIT } from "../constants.js";
import { beforeSend, afterSend, sentTodayCount, pacingLimits } from "../services/pacing.js";

export function registerMessageTools(server: McpServer): void {
  // List inbox threads
  server.registerTool(
    "freelancer_list_threads",
    {
      title: "List Message Threads",
      description: `List your Freelancer.com inbox message threads, newest first, with the other member's username, whether the thread is unread, who wrote last and a snippet of the last message.

Args:
  - context_type (string, optional): Filter by "project" or "freelancer_dashboard"
  - unread_only (boolean, default false): Only threads with messages you have not read
  - limit (number, 1-50, default 10): Number of threads
  - offset (number, default 0): Pagination offset
  - account (string, optional): ${ACCOUNT_DESC}

Returns: list of threads with members, last activity, read state and last message

Use when: "Show my inbox", "Which threads are unread?", "Who has messaged me?"`,
      inputSchema: z.object({
        context_type: z.enum(["project", "freelancer_dashboard"]).optional().describe("Thread context type"),
        unread_only: z.boolean().default(false).describe("Only unread threads"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe("Number of threads"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
        account: z.string().optional().describe(ACCOUNT_DESC),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ context_type, unread_only, limit, offset, account }) => {
      try {
        const label = resolveAccountLabel(account);
        const self = await apiGet<{ id: number }>("/users/0.1/self", undefined, label);
        const params: Record<string, unknown> = {
          limit, offset, user_details: true, context_details: true, last_message: true,
        };
        if (context_type) params["context_types[]"] = context_type;
        if (unread_only) params["is_read"] = false;

        const result = await apiGet<{ threads: FreelancerThread[]; total_count?: number; users?: Record<string, FreelancerUser> }>(
          "/messages/0.1/threads",
          params,
          label
        );
        let threads = result.threads || [];
        if (unread_only) threads = threads.filter((t) => t.is_read === false);

        if (!threads.length) {
          return { content: [{ type: "text", text: unread_only ? "No unread threads." : "No message threads found." }] };
        }

        const users = result.users || {};
        const lines = [
          `**Your inbox (${label})** — showing ${threads.length}${unread_only ? " unread" : ""} (offset ${offset}):`,
          "",
          ...threads.map((t, i) => formatThread(t, i + 1, self.id, users)),
        ];

        return {
          content: [{ type: "text", text: truncate(lines.join("\n"), CHARACTER_LIMIT) }],
          structuredContent: { account: label, threads, users },
        };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    }
  );

  // Get messages in a thread
  server.registerTool(
    "freelancer_get_messages",
    {
      title: "Get Thread Messages",
      description: `Retrieve messages from a specific Freelancer.com thread.

Args:
  - thread_id (string | number): Thread ID, or a Freelancer.com chat/message link containing one (get the ID from freelancer_list_threads if unknown)
  - limit (number, 1-50, default 20): Number of messages
  - offset (number, default 0): Pagination offset
  - account (string, optional): ${ACCOUNT_DESC}

Returns: messages with text, sender, timestamp and attachment info

Use when: "Show messages in thread 12345", "What did the client say?", "Read the conversation", "Read this chat: https://www.freelancer.com/messages/thread/12345"`,
      inputSchema: z.object({
        thread_id: z.union([z.number().int().positive(), z.string().min(1)]).describe("Thread ID, or a chat link containing one"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(20).describe("Number of messages"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
        account: z.string().optional().describe(ACCOUNT_DESC),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ thread_id: thread_id_input, limit, offset, account }) => {
      try {
        const thread_id = resolveThreadId(thread_id_input);
        const label = resolveAccountLabel(account);
        const self = await apiGet<{ id: number }>("/users/0.1/self", undefined, label);
        const result = await apiGet<{ messages: FreelancerMessage[]; total_count: number }>(
          "/messages/0.1/messages",
          {
            "threads[]": thread_id,
            limit,
            offset,
          },
          label
        );

        if (!result.messages?.length) {
          return { content: [{ type: "text", text: `No messages found in thread ${thread_id}.` }] };
        }
        const ordered = [...result.messages].sort((a, b) => (a.time_created || 0) - (b.time_created || 0));

        const lines = [
          `**Thread ${thread_id}** — ${result.total_count} messages (showing ${ordered.length}, oldest first):`,
          "",
          ...ordered.map((m) => formatMessage(m, self.id)),
        ];

        return {
          content: [{ type: "text", text: truncate(lines.join("\n"), CHARACTER_LIMIT) }],
          structuredContent: { total: result.total_count, messages: ordered, self_id: self.id },
        };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    }
  );

  // Send a message (paced)
  server.registerTool(
    "freelancer_send_message",
    {
      title: "Send Message",
      description: `Send a message in an existing Freelancer.com thread.

Sends are PACED per account (MESSAGE_MIN_GAP_S, default 45 s between messages, waited out inside the call) and capped per day (MESSAGE_DAILY_CAP, default 80), because bursts of messages get accounts limited. One call = one message; for several threads call this once per thread.

Args:
  - thread_id (string | number): The thread ID to reply to, or a Freelancer.com chat link containing one
  - message (string): Your message text
  - account (string, optional): ${ACCOUNT_DESC} This is the account the message is sent FROM.

Returns: confirmation with message ID

⚠️ This sends a real message from your account.

Use when: "Reply to thread 12345 saying...", "Message the client", "Send a follow-up"`,
      inputSchema: z.object({
        thread_id: z.union([z.number().int().positive(), z.string().min(1)]).describe("Thread ID to reply to, or a chat link containing one"),
        message: z.string().min(1).max(5000).describe("Message text to send"),
        account: z.string().optional().describe(ACCOUNT_DESC + " This is the account the message is sent FROM."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ thread_id: thread_id_input, message, account }) => {
      try {
        const thread_id = resolveThreadId(thread_id_input);
        const label = resolveAccountLabel(account);
        const waited = await beforeSend(label);
        const result = await apiPost<FreelancerMessage>(
          `/messages/0.1/threads/${thread_id}/messages`,
          { message },
          { form: true, account: label }
        );
        afterSend(label);
        const { dailyCap } = pacingLimits();

        return {
          content: [
            {
              type: "text",
              text: [
                `✅ **Message sent!**`,
                `Account: ${label}`,
                `Message ID: ${result.id}`,
                `Thread: ${thread_id}`,
                `Sent: ${formatDate(result.time_created)}${waited ? ` (paced: waited ${waited} s)` : ""}`,
                `Today from ${label}: ${sentTodayCount(label)}${dailyCap ? ` / ${dailyCap}` : ""}`,
              ].join("\n"),
            },
          ],
          structuredContent: { ...result, account: label, waited_s: waited },
        };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    }
  );

  // Mark threads as read
  server.registerTool(
    "freelancer_mark_threads_read",
    {
      title: "Mark Threads Read",
      description: `Mark one or more Freelancer.com threads as read without sending anything (PUT /messages/0.1/threads/?action=read). Use for threads that need no reply: spam, closed support sessions, other freelancers offering work, deleted projects.

Args:
  - thread_ids (array of number | string): Thread IDs or chat links (1-100)
  - account (string, optional): ${ACCOUNT_DESC}

Returns: confirmation

Use when: "Mark these threads as read", "Clear the unread badge on thread 12345"`,
      inputSchema: z.object({
        thread_ids: z.array(z.union([z.number().int().positive(), z.string().min(1)])).min(1).max(100).describe("Thread IDs or chat links"),
        account: z.string().optional().describe(ACCOUNT_DESC),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ thread_ids, account }) => {
      try {
        const label = resolveAccountLabel(account);
        const ids = thread_ids.map(resolveThreadId);
        await apiPut<unknown>("/messages/0.1/threads/", undefined, label, { "threads[]": ids, action: "read" });
        return {
          content: [{ type: "text", text: `✅ Marked ${ids.length} thread(s) as read on ${label}: ${ids.join(", ")}` }],
          structuredContent: { account: label, thread_ids: ids },
        };
      } catch (err) {
        return mcpError((err as Error).message);
      }
    }
  );
}

function formatThread(t: FreelancerThread, index: number, selfId: number, users: Record<string, FreelancerUser>): string {
  const th: NonNullable<FreelancerThread["thread"]> = t.thread || { id: t.id };
  const ctx = th.context;
  const ctxLabel = ctx?.type
    ? `${ctx.type}${ctx.id ? ` — ${ctx.type === "project" ? "Project " : ""}${ctx.id}` : ""}`
    : th.thread_type ?? "chat";
  const others = (th.members ?? []).filter((m) => m !== selfId);
  const names = others.map((m) => {
    const u = users[String(m)];
    return u ? `@${u.username}${u.location?.country?.name ? ` (${u.location.country.name})` : ""}` : `user ${m}`;
  });
  const last = th.message as FreelancerMessage | undefined;
  const lastFrom = last ? (last.from_user === selfId ? "you" : "them") : "?";
  const snippet = last?.message ? last.message.replace(/\s+/g, " ").slice(0, 160) : "";
  return [
    `**${index}. Thread #${t.id}** (${ctxLabel})${t.is_read === false ? " 🔵 unread" : ""}`,
    `   With: ${names.length ? names.join(", ") : "unknown"} | Messages: ${t.message_count ?? "?"} | Last: ${lastFrom}, ${formatDate(last?.time_created ?? t.time_updated)}`,
    snippet ? `   “${snippet}${(last?.message?.length || 0) > 160 ? "…" : ""}”` : "",
    "",
  ].filter((l) => l !== "").join("\n");
}

function formatMessage(m: FreelancerMessage, selfId: number): string {
  const attachmentNote =
    m.attachments?.length
      ? `\n   📎 Attachments: ${m.attachments.map((a) => a.filename).join(", ")}`
      : "";
  const who = m.from_user === selfId ? "You" : `User ${m.from_user}`;
  return [
    `[${formatDate(m.time_created)}] **${who}:**`,
    m.message,
    attachmentNote,
    "",
  ].join("\n");
}
