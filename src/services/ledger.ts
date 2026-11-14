/**
 * Bridge to the auto-bid bot's analytics database (optional, MONGO_URI).
 *
 * The bot keeps the only reliable knowledge about an account's bid credits:
 * a ledger anchored on the last BID_LIMIT_EXCEEDED (config/_id=bid_allowance
 * for the first account, bid_allowance:<name> for the others), the account's
 * health flags (fln_accounts.<name>.last_check.limited_account: Freelancer
 * refuses every bid from a limited account) and the record of every bid it
 * placed (my_bids). A bid placed by hand through this server must respect the
 * same facts and leave the same trace, or the dashboard, the pacing and the
 * dedup go blind. Without MONGO_URI every function here is a no-op.
 */
import { MongoClient, Db } from "mongodb";

let client: MongoClient | null = null;
let db: Db | null = null;

export function ledgerEnabled(): boolean {
  return Boolean(process.env.MONGO_URI);
}

async function getDb(): Promise<Db | null> {
  if (!ledgerEnabled()) return null;
  if (db) return db;
  client = new MongoClient(process.env.MONGO_URI as string, {
    serverSelectionTimeoutMS: 3000,
    maxPoolSize: 2,
    appName: "freelancer-mcp",
  });
  await client.connect();
  db = client.db(process.env.MONGO_DB || "freelancer_analytics");
  return db;
}

export interface AllowanceDoc {
  [key: string]: unknown;
  account?: string;
  bid_limit?: number;
  bids_30d?: number;
  exhausted?: boolean;
  exhausted_at?: Date | string;
  interval_obs_s?: number;
  interval_plan_s?: number;
  interval_api_s?: number;
  placed_since?: number;
  credits_est?: number | null;
  fetched_at?: Date | string;
}

/** The account's allowance snapshot: its own doc, else the legacy unkeyed doc when it names this account. */
export async function allowanceFor(account: string): Promise<AllowanceDoc | null> {
  const d = await getDb();
  if (!d) return null;
  const own = await d.collection<AllowanceDoc>("config").findOne({ _id: `bid_allowance:${account}` } as never);
  if (own) return own;
  const legacy = await d.collection<AllowanceDoc>("config").findOne({ _id: "bid_allowance" } as never);
  if (legacy && (!legacy.account || legacy.account === account)) return legacy;
  return null;
}

export interface AccountHealth {
  enabled: boolean;
  limited?: boolean;
  checkedAt?: Date | string;
  modeSelect?: string;
}

export async function accountHealth(account: string): Promise<AccountHealth | null> {
  const d = await getDb();
  if (!d) return null;
  const doc = await d.collection("fln_accounts").findOne(
    { $or: [{ _id: account }, { name: account }] } as never,
    { projection: { enabled: 1, last_check: 1, mode_select: 1 } }
  );
  if (!doc) return null;
  const lc = (doc.last_check || {}) as { limited_account?: boolean; at?: Date | string };
  return { enabled: doc.enabled !== false, limited: lc.limited_account, checkedAt: lc.at, modeSelect: doc.mode_select };
}

export async function bidsToday(account: string): Promise<number | null> {
  const d = await getDb();
  if (!d) return null;
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  return d.collection("my_bids").countDocuments({ account, status: "placed", bid_at: { $gte: midnight } });
}

export async function placedBefore(account: string, projectId: number): Promise<{ _id: unknown; bid_at?: Date } | null> {
  const d = await getDb();
  if (!d) return null;
  return d.collection("my_bids").findOne(
    { project_id: projectId, account, status: "placed" },
    { projection: { _id: 1, bid_at: 1 } }
  ) as Promise<{ _id: unknown; bid_at?: Date } | null>;
}

/** Bids the account placed since the ledger anchor (my_bids), i.e. the credits it spent. */
export async function placedSinceAnchor(account: string, a: AllowanceDoc | null): Promise<number | null> {
  const d = await getDb();
  if (!d || !a?.exhausted_at) return null;
  return d.collection("my_bids").countDocuments({ account, status: "placed", bid_at: { $gte: new Date(a.exhausted_at) } });
}

/**
 * Credits the ledger thinks the account has banked: credits earned since the
 * last BID_LIMIT_EXCEEDED (one per planning interval) minus the bids placed
 * since (counted from my_bids, like the bot's pool line). null when unknown.
 */
export function creditsEstimate(a: AllowanceDoc | null, placedSince: number | null, now = new Date()): number | null {
  if (!a) return null;
  const anchor = a.exhausted_at ? new Date(a.exhausted_at) : null;
  const interval = Number(a.interval_plan_s || a.interval_obs_s || a.interval_api_s || 0);
  if (!anchor || !interval || placedSince === null) return typeof a.credits_est === "number" ? a.credits_est : null;
  const earned = Math.floor((now.getTime() - anchor.getTime()) / 1000 / interval);
  return Math.max(0, earned - placedSince);
}

export async function creditsFor(account: string, a: AllowanceDoc | null): Promise<number | null> {
  return creditsEstimate(a, await placedSinceAnchor(account, a));
}

export interface GuardVerdict {
  ok: boolean;
  reasons: string[];
  notes: string[];
  credits: number | null;
  bidsToday: number | null;
  health: AccountHealth | null;
}

/** Everything the bot would check before spending a credit, in one verdict. */
export async function bidGuard(account: string, projectId: number): Promise<GuardVerdict> {
  const verdict: GuardVerdict = { ok: true, reasons: [], notes: [], credits: null, bidsToday: null, health: null };
  if (!ledgerEnabled()) {
    verdict.notes.push("MONGO_URI not set: the bot's ledger was not consulted.");
    return verdict;
  }
  try {
    const [allowance, health, today, dup] = await Promise.all([
      allowanceFor(account), accountHealth(account), bidsToday(account), placedBefore(account, projectId),
    ]);
    verdict.health = health;
    verdict.bidsToday = today;
    verdict.credits = await creditsFor(account, allowance);
    if (dup) {
      verdict.ok = false;
      verdict.reasons.push(`${account} already placed a bid on project ${projectId}` +
        (dup.bid_at ? ` on ${new Date(dup.bid_at).toISOString().slice(0, 10)}` : "") + " (my_bids).");
    }
    if (health?.limited === true) {
      verdict.ok = false;
      verdict.reasons.push(`Freelancer marks ${account} as a limited account (checked ${health.checkedAt ?? "recently"}): every bid is refused with RESTRICTED_FROM_BIDDING.`);
    }
    if (allowance?.exhausted === true || (verdict.credits !== null && verdict.credits < 1)) {
      verdict.ok = false;
      verdict.reasons.push(`${account} has no bid credit banked (ledger: ${verdict.credits ?? "exhausted"}). The next credit lands about every ${Math.round(Number(allowance?.interval_plan_s || allowance?.interval_obs_s || 0) / 60)} min.`);
    }
    if (health && !health.enabled) {
      verdict.notes.push(`${account} is switched OFF for auto-bid in the bot; a manual bid is still allowed.`);
    }
    if (!allowance) verdict.notes.push(`No allowance record for ${account} yet (no bid limit seen): credits unknown.`);
  } catch (err) {
    verdict.notes.push(`Ledger unavailable (${(err as Error).message}); bidding without the guard.`);
  }
  return verdict;
}

export interface BidRecordInput {
  account: string;
  projectId: number;
  amount: number;
  period: number;
  description: string;
  project?: Record<string, unknown> | null;
  bid?: { id?: number; bidder_id?: number } | null;
  status: "placed" | "failed";
  errorCode?: string | null;
}

/** Upsert the attempt into my_bids with the bot's own field names (via "mcp"). */
export async function recordBid(input: BidRecordInput): Promise<string | null> {
  const d = await getDb();
  if (!d) return null;
  const now = new Date();
  const p = input.project || {};
  const currency = (p.currency || {}) as { name?: string; exchange_rate?: number };
  const budget = (p.budget || {}) as { minimum?: number; maximum?: number };
  const stats = (p.bid_stats || {}) as { bid_count?: number; bid_avg?: number };
  const jobs = (p.jobs || []) as Array<{ id?: number }>;
  const rate = Number(currency.exchange_rate || 0);
  const placed = input.status === "placed";
  const bidId = Number(input.bid?.id || 0);
  const docId: unknown = placed && bidId ? bidId : `f:${input.projectId}:${now.getTime()}:${input.account}`;
  const set = {
    project_id: input.projectId,
    title: String(p.title || ""),
    category: "",
    skill_ids: jobs.map((j) => Number(j.id)).filter(Boolean),
    account: input.account,
    bidder_id: Number(input.bid?.bidder_id || 0) || null,
    via: "mcp",
    amount: Number(input.amount),
    currency_name: String(currency.name || ""),
    exchange_rate: rate,
    amount_usd: rate ? Math.round(Number(input.amount) * rate * 100) / 100 : 0,
    period: Number(input.period),
    proposal_text: input.description,
    prompt_version: "",
    language: "",
    llm_model: "manual",
    timings: {},
    project_budget_min: Number(budget.minimum || 0),
    project_budget_max: Number(budget.maximum || 0),
    budget_max_usd: rate ? Math.round(Number(budget.maximum || 0) * rate * 100) / 100 : 0,
    project_type: String(p.type || "fixed").toLowerCase(),
    bid_count_at_bid: Number(stats.bid_count || 0),
    bid_avg_at_bid: Number(stats.bid_avg || 0),
    status: input.status,
    error_code: input.errorCode ?? null,
    outcome: placed ? "pending" : null,
    won: null,
  };
  await d.collection("my_bids").updateOne({ _id: docId } as never, { $set: set, $setOnInsert: { bid_at: now } }, { upsert: true });
  return String(docId);
}
