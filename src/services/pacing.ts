/**
 * Outbound-message pacing. A burst of messages from one account is what
 * Freelancer's abuse detection reacts to (an account of ours was limited
 * after bulk activity), so sends from this process are spaced out per account
 * and capped per UTC day. The gap is waited out inside the tool call (it is
 * at most MESSAGE_MIN_GAP_S), the cap is a refusal.
 */
const MIN_GAP_S = Math.max(0, Number(process.env.MESSAGE_MIN_GAP_S ?? 45));
const DAILY_CAP = Math.max(0, Number(process.env.MESSAGE_DAILY_CAP ?? 80));

const lastSent: Map<string, number> = new Map();
const sentToday: Map<string, { day: string; n: number }> = new Map();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function pacingLimits(): { minGapS: number; dailyCap: number } {
  return { minGapS: MIN_GAP_S, dailyCap: DAILY_CAP };
}

export function sentTodayCount(account: string): number {
  const c = sentToday.get(account);
  return c && c.day === today() ? c.n : 0;
}

/** Throws when the daily cap is reached; otherwise waits out the remaining gap and returns the wait in seconds. */
export async function beforeSend(account: string): Promise<number> {
  if (DAILY_CAP && sentTodayCount(account) >= DAILY_CAP) {
    throw new Error(`Message cap reached: ${account} already sent ${DAILY_CAP} messages today (MESSAGE_DAILY_CAP). Try again tomorrow or raise the cap deliberately.`);
  }
  const last = lastSent.get(account) || 0;
  const waitMs = Math.max(0, last + MIN_GAP_S * 1000 - Date.now());
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  return Math.round(waitMs / 1000);
}

export function afterSend(account: string): void {
  lastSent.set(account, Date.now());
  const d = today();
  const c = sentToday.get(account);
  sentToday.set(account, c && c.day === d ? { day: d, n: c.n + 1 } : { day: d, n: 1 });
}
