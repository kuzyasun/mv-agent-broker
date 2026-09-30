/**
 * Resource admission: reservations inside the authoritative admission
 * transaction (spec §6.5.3, §7.2 step 6, §15.1 defaults).
 * All checks and inserts happen inside the same serialized metadata boundary.
 */
import type { RegistryDb } from "../storage/db.ts";
import {
  countActiveReservations,
  countOpenSessionsByProject,
  insertReservation,
} from "../storage/repo.ts";
import { BrokerError } from "../shared/errors.ts";
import { newId, ID_PREFIX } from "../shared/ids.ts";
import type { Limits, ReservationRecord } from "../shared/api-types.ts";

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
    records.push(mk("workspace_lease", args.workspace_id));
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

export function checkWorkspaceLeaseAvailable(db: RegistryDb, workspace_id: string): void {
  const active = countActiveReservations(db, "workspace_lease", workspace_id);
  if (active > 0) {
    throw new BrokerError("WORKSPACE_BUSY", "Workspace already has an exclusive broker-owned writer.", {
      details: { workspace_id },
    });
  }
}
