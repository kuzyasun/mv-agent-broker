import { describe, expect, it } from "vitest";
import { computeEffectiveWritePolicy, sessionWriteScope } from "../../src/core/policy.ts";
import { BrokerError } from "../../src/shared/errors.ts";
import { createHarness, settle, start } from "../helpers/harness.ts";

describe("access-only policy", () => {
  it("derives a whole-project write directive and ignores removed profile scope fields", () => {
    const result = computeEffectiveWritePolicy({
      policy_profile_id: "writer",
      policy_profile_version: "1",
      profileConfigJson: JSON.stringify({ access: "workspace_write", write_scope: ["src"] }),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.access).toBe("workspace_write");
      expect(result.policy.write_scope).toEqual(["."]);
      expect(result.policy.requested_access).toBeNull();
    }
  });

  it("allows read-only narrowing and rejects access widening", () => {
    const narrowed = computeEffectiveWritePolicy({
      policy_profile_id: "writer",
      policy_profile_version: "1",
      profileConfigJson: JSON.stringify({ access: "workspace_write" }),
      requestedAccess: "read_only",
    });
    expect(narrowed.ok && narrowed.policy.write_scope).toEqual([]);

    const widened = computeEffectiveWritePolicy({
      policy_profile_id: "reader",
      policy_profile_version: "1",
      profileConfigJson: JSON.stringify({ access: "read_only" }),
      requestedAccess: "workspace_write",
    });
    expect(widened).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });

  it("requires a valid access profile", () => {
    for (const profileConfigJson of ["bad json", "[]", JSON.stringify({ access: "admin" })]) {
      expect(computeEffectiveWritePolicy({
        policy_profile_id: "bad",
        policy_profile_version: "1",
        profileConfigJson,
      })).toMatchObject({ ok: false, code: "POLICY_UNSUPPORTED" });
    }
  });

  it("spawns physical sessions without coverage snapshots and sends a plain task", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      expect(spawn.initial_snapshot_id).toBeNull();
      expect(h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id).latest_snapshot_id).toBeNull();
      expect(sessionWriteScope(h.db, h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id)))
        .toMatchObject({ kind: "declared", prefixes: ["."] });

      const sent = h.core.send(h.seed.coordinatorId, {
        session_id: spawn.session_id,
        idempotency_key: "plain-task",
        task: { goal: "Run a plain local task." },
      });
      h.adapter.plan(sent.turn_id, [{ kind: "complete", outcome: "completed", summary: "done" }]);
      await start(h, sent);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, sent.turn_id)).toMatchObject({
        state: "SUCCEEDED",
        final_snapshot_id: null,
      });
    } finally {
      h.cleanup();
    }
  });

  it("rejects removed policy_restrictions input without accepting a session", async () => {
    const h = createHarness();
    try {
      const before = (h.db.raw.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count;
      await expect(h.spawnWorkerSession({ policy_restrictions: { access: "read_only" } })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      } satisfies Partial<BrokerError>);
      expect((h.db.raw.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count).toBe(before);
    } finally {
      h.cleanup();
    }
  });

  it("read-only access remains a coordinator directive and permits a plain completed turn", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession({ access: "read_only" });
      expect(sessionWriteScope(h.db, h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id)))
        .toMatchObject({ kind: "declared", prefixes: [] });
      const sent = h.sendTask(spawn.session_id, "readonly-plain");
      h.adapter.plan(sent.turn_id, [{ kind: "complete", outcome: "completed", summary: "audit done" }]);
      await start(h, sent);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, sent.turn_id)).toMatchObject({ state: "SUCCEEDED", final_snapshot_id: null });
    } finally {
      h.cleanup();
    }
  });
});
