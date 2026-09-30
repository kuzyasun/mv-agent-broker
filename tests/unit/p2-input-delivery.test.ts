import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createHarness, settle, start } from "../helpers/harness.ts";
import { BrokerError } from "../../src/shared/errors.ts";

function expectBrokerError(fn: () => unknown, code: string): BrokerError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BrokerError);
    expect((e as BrokerError).code).toBe(code);
    return e as BrokerError;
  }
  throw new Error(`expected BrokerError ${code}, call succeeded`);
}

describe("required input delivery (§7.1.1)", () => {
  it("inline required artifact: manifest sealed before dispatch, released after terminal", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const art = h.publishArtifact("finding-1: parser off-by-one\nfinding-2: missing test\n");
      const t1 = h.sendTask(spawn.session_id, "fix-1", "Fix findings.", {
        task: {
          goal: "Fix findings.",
          acceptance_criteria: ["all addressed"],
          artifact_refs: [art.artifact_id],
        },
      });
      h.adapter.plan(t1.turn_id, [
        { kind: "barrier", name: "hold-inline" },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(h, t1);

      const turn = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turn.input_manifest_id).toBeTruthy();
      const runningEvents = h.core.turnEvents(h.seed.coordinatorId, t1.turn_id, 0, 50);
      expect(runningEvents.some((e) => e.type === "input_manifest_sealed")).toBe(true);

      h.adapter.releaseBarrier("hold-inline");
      await settle(h);

      const finalTurn = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(finalTurn.state).toBe("SUCCEEDED");
      const finalEvents = h.core.turnEvents(h.seed.coordinatorId, t1.turn_id, 0, 50);
      expect(finalEvents.some((e) => e.type === "input_views_released")).toBe(true);
      expect(existsSync(path.join(h.inputRoot, t1.turn_id))).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it("path-delivered oversized artifact: view bytes on disk under lease, removed after quiescence", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const big = "x".repeat(17 * 1024);
      const art = h.publishArtifact(big);
      const t1 = h.sendTask(spawn.session_id, "fix-2", "Use big input.", {
        task: {
          goal: "Use big input.",
          acceptance_criteria: ["done"],
          artifact_refs: [art.artifact_id],
        },
      });
      h.adapter.plan(t1.turn_id, [
        { kind: "barrier", name: "hold-path" },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(h, t1);

      const viewPath = path.join(h.inputRoot, t1.turn_id, "in-1.txt");
      expect(existsSync(viewPath)).toBe(true);
      expect(readFileSync(viewPath, "utf8")).toBe(big);

      h.adapter.releaseBarrier("hold-path");
      await settle(h);

      const finalTurn = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(finalTurn.state).toBe("SUCCEEDED");
      expect(existsSync(viewPath)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it("A35 subset: unknown / expired / unsealed required artifacts are rejected before inference", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();

      expectBrokerError(
        () =>
          h.sendTask(spawn.session_id, "bad-1", "g", {
            task: { goal: "g", acceptance_criteria: ["x"], artifact_refs: ["art-does-not-exist"] },
          }),
        "UNAUTHORIZED", // §7.1.1: unknown/disallowed artifact id — no existence disclosure
      );

      const art = h.publishArtifact("will expire");
      h.db.raw.prepare("UPDATE artifacts SET state='expired' WHERE artifact_id=?").run(art.artifact_id);
      expectBrokerError(
        () =>
          h.sendTask(spawn.session_id, "bad-2", "g", {
            task: { goal: "g", acceptance_criteria: ["x"], artifact_refs: [art.artifact_id] },
          }),
        "ARTIFACT_EXPIRED",
      );

      const art2 = h.publishArtifact("staging");
      h.db.raw.prepare("UPDATE artifacts SET state='staging' WHERE artifact_id=?").run(art2.artifact_id);
      expectBrokerError(
        () =>
          h.sendTask(spawn.session_id, "bad-3", "g", {
            task: { goal: "g", acceptance_criteria: ["x"], artifact_refs: [art2.artifact_id] },
          }),
        "ARTIFACT_NOT_READY",
      );

      expect((h.db.raw.prepare("SELECT COUNT(*) c FROM turns").get() as { c: number }).c).toBe(0);
    } finally {
      h.cleanup();
    }
  });
});
