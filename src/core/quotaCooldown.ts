/**
 * Shared quota-scope cooldown (operator-requested pause learning).
 *
 * A cooldown is recorded ONLY when actual execution definitively reports
 * QUOTA_EXHAUSTED (explicit vendor FAILED result error — never timeouts,
 * silence, arbitrary prose, cancellations or UNKNOWN outcomes). The pause is
 * shared per quota scope: while active it blocks NEW sends across every
 * project/account bound to the same scope, and a pre-dispatch recheck stops
 * already accepted turns so they cannot bypass a newly learned pause.
 *
 * The vendor suffix "Resets in 54m59s." is parsed into a bounded
 * retry_after_ms when present; without a valid suffix the documented 15-minute
 * conservative policy applies (this is broker policy, never a claimed vendor
 * reset time).
 */
import type { RegistryDb } from "../storage/db.ts";

/** Documented conservative cooldown when the vendor gives no usable reset time. */
export const DEFAULT_QUOTA_COOLDOWN_MS = 15 * 60_000;

/** Vendor reset suffixes are trusted only within this bound (finite positive ≤ 24h). */
export const MAX_VENDOR_RESET_MS = 24 * 3_600_000;

export type QuotaCooldownSource = "vendor_reset_suffix" | "conservative_policy";

export interface QuotaCooldownRecord {
  quota_scope_id: string;
  provider: string;
  until_ms: number;
  retry_after_ms: number;
  source: QuotaCooldownSource;
  recorded_at: number;
  recorded_by_turn_id: string;
}

/**
 * Observed vendor diagnostic suffix ("Resets in 54m59s.", optionally with
 * hours "Resets in 1h2m3s." or seconds only "Resets in 45s."). Matched
 * at the end of the detail, with strict duration grammar: integer h/m/s
 * components, at least one required (an empty match totals zero and is
 * rejected), finite positive total ≤ 24h. Anything else returns null →
 * conservative policy.
 */
const VENDOR_RESET_RE = /Resets\s+in\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?\.?\s*$/i;

export function parseVendorResetMs(detail: string | null | undefined): number | null {
  if (typeof detail !== "string") return null;
  const match = VENDOR_RESET_RE.exec(detail);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  const totalMs = (hours * 3_600 + minutes * 60 + seconds) * 1_000;
  if (!Number.isSafeInteger(totalMs) || totalMs <= 0 || totalMs > MAX_VENDOR_RESET_MS) return null;
  return totalMs;
}

interface CooldownRow {
  quota_scope_id: string;
  provider: string;
  until_ms: number;
  retry_after_ms: number;
  source: string;
  recorded_at: number;
  recorded_by_turn_id: string;
}

function rowToRecord(row: CooldownRow): QuotaCooldownRecord {
  return {
    quota_scope_id: String(row.quota_scope_id),
    provider: String(row.provider),
    until_ms: Number(row.until_ms),
    retry_after_ms: Number(row.retry_after_ms),
    source: row.source === "vendor_reset_suffix" ? "vendor_reset_suffix" : "conservative_policy",
    recorded_at: Number(row.recorded_at),
    recorded_by_turn_id: String(row.recorded_by_turn_id),
  };
}

export interface RecordQuotaCooldownArgs {
  quotaScopeId: string;
  provider: string;
  turnId: string;
  /** The bounded QUOTA_EXHAUSTED detail; scanned for the optional vendor reset suffix. */
  detail: string | null | undefined;
  now: number;
}

/**
 * Record (or extend) the scope's cooldown transactionally. An already active
 * longer pause is never shortened; expired rows are pruned. Runs inside the
 * caller's transaction when one is open (the terminal commit owns the
 * boundary); the statement sequence itself is idempotent per scope.
 */
export function recordQuotaCooldown(db: RegistryDb, args: RecordQuotaCooldownArgs): QuotaCooldownRecord {
  const vendorMs = parseVendorResetMs(args.detail);
  const retryAfterMs = vendorMs ?? DEFAULT_QUOTA_COOLDOWN_MS;
  const source: QuotaCooldownSource = vendorMs === null ? "conservative_policy" : "vendor_reset_suffix";
  const until = args.now + retryAfterMs;
  db.raw.prepare("DELETE FROM quota_scope_cooldowns WHERE until_ms <= ?").run(args.now);
  const existing = db.raw
    .prepare("SELECT until_ms FROM quota_scope_cooldowns WHERE quota_scope_id = ?")
    .get(args.quotaScopeId) as { until_ms: number } | undefined;
  if (existing && Number(existing.until_ms) > until) {
    return activeQuotaCooldown(db, args.quotaScopeId, args.now)!;
  }
  db.raw.prepare(
    `INSERT INTO quota_scope_cooldowns
       (quota_scope_id, provider, until_ms, retry_after_ms, source, recorded_at, recorded_by_turn_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(quota_scope_id) DO UPDATE SET
       provider = excluded.provider,
       until_ms = excluded.until_ms,
       retry_after_ms = excluded.retry_after_ms,
       source = excluded.source,
       recorded_at = excluded.recorded_at,
       recorded_by_turn_id = excluded.recorded_by_turn_id`,
  ).run(args.quotaScopeId, args.provider, until, retryAfterMs, source, args.now, args.turnId);
  return {
    quota_scope_id: args.quotaScopeId,
    provider: args.provider,
    until_ms: until,
    retry_after_ms: retryAfterMs,
    source,
    recorded_at: args.now,
    recorded_by_turn_id: args.turnId,
  };
}

/** The scope's active pause at `now`, or null when it expired or never existed. */
export function activeQuotaCooldown(db: RegistryDb, quotaScopeId: string, now: number): QuotaCooldownRecord | null {
  const row = db.raw
    .prepare("SELECT * FROM quota_scope_cooldowns WHERE quota_scope_id = ? AND until_ms > ?")
    .get(quotaScopeId, now) as CooldownRow | undefined;
  return row ? rowToRecord(row) : null;
}

/** All active pauses (safe metadata only — no provider output). */
export function listActiveQuotaCooldowns(db: RegistryDb, now: number): QuotaCooldownRecord[] {
  const rows = db.raw
    .prepare("SELECT * FROM quota_scope_cooldowns WHERE until_ms > ? ORDER BY until_ms DESC, quota_scope_id ASC")
    .all(now) as unknown as CooldownRow[];
  return rows.map(rowToRecord);
}

/** Operator-initiated clear. Returns true when an active row was removed. */
export function clearQuotaCooldown(db: RegistryDb, quotaScopeId: string, now: number): boolean {
  const result = db.raw
    .prepare("DELETE FROM quota_scope_cooldowns WHERE quota_scope_id = ? AND until_ms > ?")
    .run(quotaScopeId, now);
  return Number(result.changes) > 0;
}
