# Freelancer MCP Server

An [MCP](https://modelcontextprotocol.io) server that connects Claude (Desktop, Code, or any MCP-compatible client) directly to Freelancer.com. Search and bid on projects, read and reply to client messages, review your track record, and manage skills/specialty profiles — all from a chat.

Supports **multiple Freelancer accounts in one server** (e.g. your own account plus one or more clients' accounts you manage), switchable per tool call.

This project is 100% self-contained: it talks only to `freelancer.com`'s public API using whatever access token(s) you provide. No other data source, project, or third-party service is involved.

## Get your access token (do this first)

1. Log in to Freelancer.com
2. Go to **[accounts.freelancer.com/settings/develop](https://accounts.freelancer.com/settings/develop)**
3. Under **Application Dashboard**, click **Generate Token**
4. Copy the token shown under **Access Token**

![Where to generate your Freelancer access token](assets/access-token.png)

That token is all this server needs — no password, no app review, no OAuth redirect flow. Repeat this for each additional Freelancer account you want connected (see [Multiple accounts](#multiple-accounts)).

## What you can ask Claude

| Tool | Example prompt |
|---|---|
| `freelancer_list_accounts` | "Which Freelancer accounts are connected?" |
| `freelancer_get_self` | "Show my profile and reputation" |
| `freelancer_get_user` | "Look up @some_freelancer on Freelancer" |
| `freelancer_search_projects` | "Find the latest n8n automation projects under $500" |
| `freelancer_get_project` | "Get details on project 12345678" |
| `freelancer_my_projects` | "List my active projects" / "Show my completed projects" |
| `freelancer_get_project_bids` | "Who has bid on project 12345 and how much?" |
| `freelancer_my_bids` | "Show my awarded bids" / "Show my rejected bids" |
| `freelancer_place_bid` | "Bid $200 on project 12345 with 5-day delivery" |
| `freelancer_get_milestones` | "What milestones are on project 12345?" |
| `freelancer_list_threads` | "Show my inbox" |
| `freelancer_get_messages` | "Read this chat: freelancer.com/messages/thread/98765" |
| `freelancer_send_message` | "Reply to thread 98765 saying..." |
| `freelancer_search_skills` / `list_skills` / `add_skills` / `remove_skills` / `set_skills` | "Add n8n and Zapier to my skills" |
| `freelancer_list_profiles` / `create_profile` / `update_profile` | "Create a specialty profile for AI automation" |

Every tool accepts an optional `account` argument to pick which connected Freelancer account it should act on/as (see [Multiple accounts](#multiple-accounts)).

### Analyzing past projects & winning strategy

There's no single "analyze my strategy" button — instead, Claude does the analysis itself over the raw data this server exposes. This keeps the server a thin, honest API wrapper instead of a black box. Ask things like:

> "Pull my awarded bids and my rejected bids, then compare amount, delivery time, and proposal length/style to figure out what's working."

> "Look at my completed projects and tell me which skills show up most often."

> "Compare my bid on project X to the other bids on it — am I priced competitively?"

Claude will chain `freelancer_my_bids` (status `awarded` vs `rejected`), `freelancer_my_projects` (status `complete`), and `freelancer_get_project_bids` to gather the data, then reason over it directly in the conversation.

### Chat links and thread IDs

`freelancer_get_messages` and `freelancer_send_message` accept either a plain numeric thread ID or a pasted Freelancer chat/message link — the server extracts the ID either way.

## See it in action

**Finding and scoring the best projects to bid on, with a ready pitch script for each:**
![Claude finding CRM projects worth bidding on, with per-project pitch scripts](assets/demo-find-jobs.jpeg)

**Reading a client thread by chat link and building a conversion strategy:**
![Claude reading a client message thread and giving a strategy to convert them](assets/demo-client-strategy.jpeg)

**Auditing skills already on a profile:**
![Claude listing all skills on a Freelancer profile, grouped by category](assets/demo-list-skills.jpeg)

## Setup

The package is published on npm as [`freelancer-mcp-server`](https://www.npmjs.com/package/freelancer-mcp-server) — no clone, no build, `npx` fetches and runs it on demand.

### Claude Code (CLI)

```bash
claude mcp add freelancer --env FREELANCER_OAUTH_TOKEN=your_token_here -- npx -y freelancer-mcp-server
```

Or just ask Claude Code directly, in plain English, once you have your token:

> "Add the freelancer-mcp-server MCP server using npx, with my Freelancer access token set as FREELANCER_OAUTH_TOKEN"

Claude Code can run the `claude mcp add` command itself — you don't have to type it.

### Claude Desktop

Open your Claude Desktop config file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add this block inside `"mcpServers"` (create the file if it doesn't exist):

```json
{
  "mcpServers": {
    "freelancer": {
      "command": "npx",
      "args": ["-y", "freelancer-mcp-server"],
      "env": {
        "FREELANCER_OAUTH_TOKEN": "your_token_here"
      }
    }
  }
}
```

Restart Claude Desktop — you should see a 🔌 indicating the server connected.

### Multiple accounts

To connect more than one Freelancer account (your own plus, say, two clients'), use `FREELANCER_ACCOUNTS` instead of `FREELANCER_OAUTH_TOKEN` — a JSON object mapping a label you choose to each token:

```json
{
  "mcpServers": {
    "freelancer": {
      "command": "npx",
      "args": ["-y", "freelancer-mcp-server"],
      "env": {
        "FREELANCER_ACCOUNTS": "{\"main\":\"token1\",\"client_acme\":\"token2\"}"
      }
    }
  }
}
```

Or via `claude mcp add`:

```bash
claude mcp add freelancer --env FREELANCER_ACCOUNTS='{"main":"token1","client_acme":"token2"}' -- npx -y freelancer-mcp-server
```

The first account listed becomes the default (used when a tool call omits `account`). Ask Claude "which Freelancer accounts are connected?" to confirm, then say e.g. "using the client_acme account, show me the latest projects" to target a specific one. Tokens are never logged, echoed back, or written anywhere by this server — they only ever go into the outgoing `freelancer-oauth-v1` header.

### Running from source (contributing)

```bash
git clone https://github.com/godesigntech/freelancer-mcp-server.git
cd freelancer-mcp-server
npm install
npm run build
claude mcp add freelancer --env FREELANCER_OAUTH_TOKEN=your_token_here -- node /FULL/PATH/TO/freelancer-mcp-server/dist/index.js
```

## Testing

Ask Claude:
> "Show my Freelancer profile"

If it responds with your username and stats, you're set.

## Profile editing — what the Freelancer API actually allows

The Freelancer.com public REST API is read-mostly for profiles. After probing the live API, here's the real boundary:

**Editable:**
- ✅ Skills/jobs — add, remove, or replace the skills on an account (`/users/0.1/self/jobs`). Freelancer caps the total number of skills per account.
- ✅ Specialty profiles — create/update focused sub-profiles (`/users/0.1/profiles`): tagline, hourly_rate, description, skills. **Caveats:** the API has no endpoint to list your own profile IDs (you must already know them), and some account types (e.g. certain corporate accounts) cannot create new ones.

**NOT possible via the public API (web-UI only):**
- ❌ Main account bio/tagline/hourly rate shown on your public page
- ❌ Profile photo / avatar
- ❌ Experience, education, publications, references, certifications
- ❌ Portfolio (read-only via API)

## Security notes

- Tokens live only in your local MCP client config (or `.env` for `npm run dev`) — never committed, never sent anywhere but Freelancer's own API.
- The server runs entirely on your machine; no telemetry, no third-party calls.
- Destructive/real-world actions (`place_bid`, `send_message`, skill/profile edits) always surface for your review before they execute, since Claude shows tool calls before running them.
- This repo contains no data from, and no dependency on, any other project — it's a clean, standalone Freelancer.com integration.

## Troubleshooting

**"no Freelancer accounts configured"**
→ Set `FREELANCER_OAUTH_TOKEN` or `FREELANCER_ACCOUNTS` in your MCP client config.

**401 Unauthorized**
→ Token expired or wrong. Generate a fresh one at https://accounts.freelancer.com/settings/develop

**"Unknown account "x""**
→ Run `freelancer_list_accounts` to see the exact labels configured, then use one of those.

**Tool not appearing in Claude**
→ If using `npx`, confirm Node.js 18+ is installed and `npx -y freelancer-mcp-server` runs without error from a terminal. If running from source, confirm the path in your config is the absolute path to `dist/index.js`, and that `npm run build` succeeded.

## Contributing

Issues and PRs welcome. Keep changes scoped to the Freelancer.com API surface — this project intentionally stays a single-purpose, dependency-light MCP server.

## License

MIT

## Fork additions (terabyte-26, v2.1.0)

This fork is operated next to an auto-bid bot and adds what that setup needs:

- **Per-account egress.** `FREELANCER_ACCOUNTS` values may be `{"token": "...", "proxy": "http://user:pass@host:port"}` (http, https, socks5, socks5h). Every call of that account leaves through its proxy; the process environment's proxy variables are ignored. `freelancer_check_egress` shows the public IP and the username behind each account so you can prove two accounts never share an IP.
- **Guarded, recorded bids.** With `MONGO_URI` (the bot's analytics database, `MONGO_DB` default `freelancer_analytics`), `freelancer_place_bid` first checks the bot's facts: a bid already placed on that project by that account (`my_bids`), an account Freelancer marks as limited (`fln_accounts.last_check.limited_account`, every bid is refused), and the credit ledger (`config/bid_allowance*`: no credit banked since the last `BID_LIMIT_EXCEEDED`). A blocked bid returns the reasons; `force: true` overrides. Every attempt is written to `my_bids` with `via: "mcp"`, so dashboards, pacing and dedup see manual bids too. `freelancer_credit_status` shows the same facts on demand.
- **Paced messaging.** `freelancer_send_message` waits `MESSAGE_MIN_GAP_S` (45) between messages of one account and refuses past `MESSAGE_DAILY_CAP` (80) a day. Bursts are what get accounts limited.
- **Inbox tooling.** `freelancer_list_threads` shows the other member's username and country, unread state, who wrote last and a snippet (`unread_only: true` to triage); `freelancer_get_messages` prints oldest first and marks your own messages; `freelancer_mark_threads_read` clears threads that need no reply.

`npm run smoke` speaks MCP to the built server and exercises the read-only tools (set `SMOKE_PROJECT_ID` to a project the account already bid on to see the duplicate guard block a bid).
