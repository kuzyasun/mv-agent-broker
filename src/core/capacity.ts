/**
 * Resource admission: reservations inside the authoritative admission
 * transaction (spec §6.5.3, §7.2 step 6, §15.1 defaults).
 * All checks and inserts happen inside the same serialized metadata boundary.
 */
import type { RegistryDb } from "../storage/db.ts";
import {
  countActiveReservations,
  countOpenSessionsByProject,
  getSession,
  getWorkspace,
  insertReservation,
  listActiveReservations,
} from "../storage/repo.ts";
import { BrokerError } from "../shared/errors.ts";
import { newId, ID_PREFIX } from "../shared/ids.ts";
import type { Limits, ReservationRecord, WorkspaceRecord } from "../shared/api-types.ts";
import {
  isPhysicalLeaseScope,
  resolvePhysicalCheckoutIdentity,
  type PhysicalCheckoutIdentity,
} from "../workspaces/identity.ts";

export function checkTurnCapacity(
  db: RegistryDb,
  limits: Limits,
  quotaScopeId: string,
): void {
  const globalActive = countActiveReservations(db, "turn_global", "global");
  if (globalActive >= limits.globalUnfinishedTurns) {
    throw new BrokerError("RESOURCE_BUSY", "Global unfinished-turn capacity is exhausted.", {
      details: { active: globalActive, cap: limits.globalUnfinishedTurns },
    });
  }
  const quotaActive = countActiveReservations(db, "turn_quota_scope", quotaScopeId);
  if (quotaActive >= limits.quotaScopeUnfinishedTurns) {
    throw new BrokerError("RESOURCE_BUSY", "Quota-scope unfinished-turn capacity is exhausted.", {
      details: { quota_scope_id: quotaScopeId, active: quotaActive, cap: limits.quotaScopeUnfinishedTurns },
    });
  }
}

/** One unfinished turn per session (INV-01); enforced by unique index too. */
export function reserveTurn(
  db: RegistryDb,
  now: number,
  args: {
    session_id: string;
    turn_id: string;
    quota_scope_id: string;
    workspace_id: string | null; // writer lease target (INV-02)
    /** Durable lease scope: authoritative physical checkout identity (A05); falls back to workspace_id. */
    workspace_lease_scope?: string | null;
  },
): ReservationRecord[] {
  const mk = (kind: ReservationRecord["kind"], scope: string): ReservationRecord => ({
    reservation_id: newId(ID_PREFIX.reservation),
    kind,
    scope,
    mode: "exclusive",
    owner_session_id: args.session_id,
    owner_turn_id: args.turn_id,
    created_at: now,
    released_at: null,
  });
  const records: ReservationRecord[] = [
    mk("turn_global", "global"),
    mk("turn_quota_scope", args.quota_scope_id),
    mk("turn_session", args.session_id),
  ];
  if (args.workspace_id) {
    records.push(mk("workspace_lease", args.workspace_lease_scope ?? args.workspace_id));
  }
  for (const rec of records) insertReservation(db, rec);
  return records;
}

export function reserveSessionSlot(
  db: RegistryDb,
  now: number,
  session_id: string,
  project_id: string,
  cap: number,
): ReservationRecord {
  const open = countOpenSessionsByProject(db, project_id);
  if (open >= cap) {
    throw new BrokerError("RESOURCE_BUSY", "Open logical session cap for this project is exhausted.", {
      details: { project_id, open, cap },
    });
  }
  const rec: ReservationRecord = {
    reservation_id: newId(ID_PREFIX.reservation),
    kind: "session_slot",
    scope: project_id,
    mode: "exclusive",
    owner_session_id: session_id,
    owner_turn_id: null,
    created_at: now,
    released_at: null,
  };
  insertReservation(db, rec);
  return rec;
}

// ─── workspace lease targeting (A05: real checkout alias exclusion) ─────────

/**
 * Writer lease target for one registered workspace (A05): the authoritative
 * physical checkout identity when the registered canonical_path resolves on
 * disk, else null — path-less workspaces keep the conservative legacy
 * workspace_id scope (there is no provable physical aliasing for them).
 */
export interface WorkspaceLeaseTarget {
  workspace_id: string;
  project_id: string;
  physical: PhysicalCheckoutIdentity | null;
}

/**
 * Resolve the lease target for a workspace row. With `requireResolvable`, a
 * registered canonical_path that does NOT resolve fails closed (INVALID_REQUEST)
 * instead of falling back to an ID scope that could bypass checkout ownership.
 */
export function workspaceLeaseTarget(
  workspace: WorkspaceRecord,
  opts: { requireResolvable?: boolean } = {},
): WorkspaceLeaseTarget {
  const physical = workspace.canonical_path ? resolvePhysicalCheckoutIdentity(workspace.canonical_path) : null;
  if (opts.requireResolvable && workspace.canonical_path && !physical) {
    throw new BrokerError(
      "INVALID_REQUEST",
      `Registered checkout path for workspace '${workspace.workspace_id}' has no stable physical identity; refusing admission.`,
      { executionStarted: false },
    );
  }
  return { workspace_id: workspace.workspace_id, project_id: workspace.project_id, physical };
}

/** Durable workspace_lease scope for a target: physical identity when known, else the legacy id. */
export function workspaceLeaseScope(target: WorkspaceLeaseTarget): string {
  return target.physical ? target.physical.scope : target.workspace_id;
}

/**
 * Does an active lease `activeScope` cover the target's checkout? Exact scope
 * equality covers same-format leases. A legacy workspace-ID lease has no
 * durable physical binding: a live registry path cannot prove its historical
 * cwd after retarget/clear. It therefore blocks physical writers until
 * reconciliation. Path-less targets retain their ID-scoped compatibility.
 */
function leaseConflictsWithTarget(db: RegistryDb, activeScope: string, target: WorkspaceLeaseTarget): boolean {
  if (activeScope === target.workspace_id) return true;
  if (activeScope === workspaceLeaseScope(target)) return true;
  if (!target.physical) return false;
  // A registered legacy ID may itself resemble our new scope grammar.
  return getWorkspace(db, activeScope) !== null || !isPhysicalLeaseScope(activeScope);
}

/** Any active exclusive lease already covers the target checkout (aliases included)? */
export function workspaceHasConflictingLease(db: RegistryDb, target: WorkspaceLeaseTarget): boolean {
  return listActiveReservations(db, "workspace_lease").some((rec) => leaseConflictsWithTarget(db, rec.scope, target));
}

/**
 * Quarantine uses the held physical lease, rather than a mutable registry
 * path. An unbound operator/legacy flag is conservative until reconciliation.
 */
function findQuarantinedCheckoutAlias(
  db: RegistryDb,
  target: WorkspaceLeaseTarget,
): { workspace_id: string; project_id: string; reason: string | null } | null {
  const rows = db.raw
    .prepare("SELECT workspace_id, project_id, canonical_path, quarantined, quarantine_reason FROM workspaces")
    .all() as Array<Record<string, unknown>>;
  const leases = listActiveReservations(db, "workspace_lease");
  for (const row of rows) {
    if (row.quarantined !== 1 && row.quarantined !== true) continue;
    const blocked = {
      workspace_id: String(row.workspace_id),
      project_id: String(row.project_id),
      reason: row.quarantine_reason === null || row.quarantine_reason === undefined ? null : String(row.quarantine_reason),
    };
    if (blocked.workspace_id === target.workspace_id) return blocked;
    if (!target.physical) continue;
    // UNKNOWN retains its durable lease; current path retargeting must never
    // move its quarantine. An operator/legacy flag without such a binding
    // cannot establish any physical checkout as safely unrelated.
    const boundScopes = leases.filter((lease) => isPhysicalLeaseScope(lease.scope) &&
      lease.owner_session_id !== null &&
      getSession(db, lease.owner_session_id)?.workspace_id === blocked.workspace_id)
      .map((lease) => lease.scope);
    if (boundScopes.length === 0 || boundScopes.includes(target.physical.scope)) return blocked;
  }
  return null;
}

/**
 * INV-02 over real checkouts (A05): one exclusive broker-owned writer per
 * physical checkout across registered workspace aliases, junction/symlink
 * aliases and Windows path casing; a quarantined alias blocks the checkout.
 * Distinct physical directories never conflict here (capacity may still).
 */
export function checkWorkspaceLeaseAvailable(db: RegistryDb, target: WorkspaceLeaseTarget): void {
  if (workspaceHasConflictingLease(db, target)) {
    throw new BrokerError("WORKSPACE_BUSY", "Workspace already has an exclusive broker-owned writer.", {
      details: { workspace_id: target.workspace_id },
    });
  }
  const quarantined = findQuarantinedCheckoutAlias(db, target);
  if (quarantined) {
    throw new BrokerError("WORKSPACE_BUSY", "Checkout is quarantined via an alias workspace.", {
      details: {
        workspace_id: target.workspace_id,
        ...(quarantined.project_id === target.project_id ? {
          quarantined_workspace_id: quarantined.workspace_id,
          reason: quarantined.reason,
        } : {}),
      },
    });
  }
}
