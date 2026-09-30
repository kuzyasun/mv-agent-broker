/**
 * Daemon deadline supervision (spec §14.6): periodic monitor owned by daemon
 * lifetime to scan active turns for hard deadline expiration.
 *
 * TurnExecutor.scanDeadlines transitions expired turns to CANCELLING, appends
 * deadline_reached, and interrupts provider adapters. Quiescence semantics
 * (§14.6) are preserved: TIMED_OUT is committed only after the adapter settles;
 * the deadline monitor never force-releases on elapsed deadline alone.
 */
import type { TurnExecutor } from "../core/execution.ts";

export interface DeadlineMonitorOptions {
  /** Polling interval in milliseconds (integer, 5..60,000). Defaults to 50ms. */
  intervalMs?: number;
}

export function validateDeadlinePollInterval(intervalMs: number): number {
  if (!Number.isInteger(intervalMs) || intervalMs < 5 || intervalMs > 60_000) {
    throw new RangeError("Deadline polling interval must be an integer between 5 and 60000 milliseconds.");
  }
  return intervalMs;
}

export class DeadlineMonitor {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private running = false;
  private scanCount = 0;
  private failureCount = 0;
  private consecutiveFailures = 0;
  private nextDiagnosticAt = 0;
  private recoveryDiagnosticPending = false;
  private readonly intervalMs: number;

  constructor(
    private readonly executor: TurnExecutor,
    options: DeadlineMonitorOptions = {},
  ) {
    this.intervalMs = validateDeadlinePollInterval(options.intervalMs ?? 50);
  }

  /** True if the monitor was started and has not been stopped. */
  get isRunning(): boolean {
    return this.running && !this.stopped;
  }

  /** True if the monitor has been stopped. */
  get isStopped(): boolean {
    return this.stopped;
  }

  /** Cumulative number of attempted deadline scans. */
  get totalScans(): number {
    return this.scanCount;
  }

  get failedScans(): number { return this.failureCount; }
  get consecutiveFailedScans(): number { return this.consecutiveFailures; }

  /**
   * Start periodic scanning. The timer is unref'd so it does not keep the
   * process event loop alive on its own.
   */
  start(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    this.timer = setInterval(() => {
      this.tick();
    }, this.intervalMs);
    if (typeof this.timer?.unref === "function") {
      this.timer.unref();
    }
  }

  /**
   * Idempotent stop: clears timer and ensures no further scan runs or DB access occurs.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Trigger a single deadline scan tick.
   * Retry after scan errors without releasing execution resources. Emit one
   * diagnostic per failure streak, capped at one pair per minute; never expose
   * arbitrary database/provider error messages in the diagnostic.
   */
  tick(): void {
    if (this.stopped) return;
    this.scanCount++;
    try {
      this.executor.scanDeadlines();
      if (this.consecutiveFailures > 0) {
        if (this.recoveryDiagnosticPending) {
          console.error(`agent-broker deadline scans recovered after ${this.consecutiveFailures} failures.`);
          this.recoveryDiagnosticPending = false;
        }
        this.consecutiveFailures = 0;
      }
    } catch {
      this.failureCount++;
      this.consecutiveFailures++;
      if (this.consecutiveFailures === 1 && Date.now() >= this.nextDiagnosticAt) {
        console.error("agent-broker deadline scan failed; supervision will retry and execution resources remain held.");
        this.nextDiagnosticAt = Date.now() + 60_000;
        this.recoveryDiagnosticPending = true;
      }
    }
  }
}
