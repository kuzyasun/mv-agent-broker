/**
 * Access control for coordinator profiles (spec §4.2, §4.3, §7.2 step 1).
 * Product-level local policy, not a hard security boundary (§4.2).
 * UNAUTHORIZED must not reveal the existence of foreign resources.
 */
import type { RegistryDb } from "../storage/db.ts";
import { getCoordinator, getProject } from "../storage/repo.ts";
import { BrokerError } from "../shared/errors.ts";

export interface AuthzContext {
  coordinatorId: string;
  projectId: string;
}

export function authorizeProjectAccess(db: RegistryDb, ctx: AuthzContext): void {
  const coordinator = getCoordinator(db, ctx.coordinatorId);
  // Single code path for unknown/revoked coordinator and unlisted project:
  // never disclose which side failed (spec A29).
  if (!coordinator || coordinator.revoked || !coordinator.allowed_project_ids.includes(ctx.projectId)) {
    throw new BrokerError("UNAUTHORIZED", "Access denied for this coordinator/project binding.", {
      retryGuidance: "operator_action_required",
    });
  }
  const project = getProject(db, ctx.projectId);
  if (!project) {
    throw new BrokerError("UNAUTHORIZED", "Access denied for this coordinator/project binding.");
  }
}

/** Owner check for session/turn-scoped tools (§4.2). */
export function authorizeOwner(
  ownerCoordinatorId: string,
  callerCoordinatorId: string,
): void {
  if (ownerCoordinatorId !== callerCoordinatorId) {
    throw new BrokerError("UNAUTHORIZED", "Access denied for this resource.");
  }
}
