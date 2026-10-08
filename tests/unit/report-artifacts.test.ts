/**
 * Offline report/findings artifact publication tests — fake mock adapter only.
 * Covers long final report tails via artifact_read, reviewer findings binding,
 * no reasoning markers in events, publication failures, real crash windows
 * (before blob / before seal / after seal), stale-incarnation fencing,
 * corruption/foreign-binding recovery, oversize rejection and pin lifetime.
 */
import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createHarness, settle, start } from "../helpers/harness.ts";
import { callBridgeTool } from "../../src/bridge/tools.ts";
import {
  getArtifact,
  getTurnEventPayload,
  insertPin,
  insertWorkspace,
  listPinsByOwner,
  sealArtifact,
} from "../../src/storage/repo.ts";
import { sanitizeAdapterEvent } from "../../src/runtime/adapter.ts";
import { executeCleanup, previewCleanup } from "../../src/storage/cleanup.ts";
import { openBlobStore } from "../../src/snapshots/blobs.ts";

function blobFilePath(h: ReturnType<typeof createHarness>, hash: string): string {
  return path.join(h.blobRoot, h.seed.projectId, hash.slice(0, 2), hash);
}

/** Read the report subjournal from the turn's pending launch_turn intent. */
function reportSubjournal(h: ReturnType<typeof createHarness>, turnId: string): Record<string, unknown> | null {
  const row = h.db.raw
    .prepare("SELECT payload FROM intents WHERE kind = 'launch_turn' AND state = 'pending' AND turn_id = ?")
    .get(turnId) as { payload: string | null } | undefined;
  if (!row?.payload) return null;
  const payload = JSON.parse(row.payload) as { report?: Record<string, unknown> };
  return payload.report ?? null;
}

function turnStatus(h: ReturnType<typeof createHarness>, turnId: string) {
  return h.core.turnStatus(h.seed.coordinatorId, turnId);
}

describe("report artifacts", () => {
  it("seals a long final report as an artifact; summary_truncated and artifact_read under ACL", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const longTail = "TAIL-" + "x".repeat(5000);
      const full = `${"front ".repeat(100)}${longTail}`;
      const t1 = h.sendTask(spawn.session_id, "rep-long-1", "Produce a long report.");
      h.adapter.plan(t1.turn_id, [
        { kind: "complete", outcome: "completed", summary: full },
      ]);
      await start(h, t1);
      await settle(h);

      const turn = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turn.state).toBe("SUCCEEDED");

      const ctx = {
        core: h.core,
        coordinatorId: h.seed.coordinatorId,
        daemonState: null,
        incarnation: "test",
      };
      const result = await callBridgeTool(ctx, "agent_turn_result", { turn_id: t1.turn_id }) as {
        summary_truncated: boolean;
        full_message_artifact_id: string | null;
        artifacts: Array<{ artifact_id: string; kind: string }>;
        agent_reported: { summary: string; truncated?: boolean; full_message_artifact_id?: string };
        quality_status: string;
      };
      expect(result.quality_status).toBe("unreviewed");
      expect(result.summary_truncated).toBe(true);
      expect(result.agent_reported.summary.length).toBe(4000);
      expect(result.agent_reported.summary.includes(longTail)).toBe(false);
      expect(result.full_message_artifact_id).toBeTruthy();
      expect(result.artifacts).toEqual([
        { artifact_id: result.full_message_artifact_id, kind: "report" },
      ]);

      const tailOffset = Buffer.byteLength(full.slice(0, full.indexOf("TAIL-")), "utf8");
      const page = await callBridgeTool(ctx, "agent_artifact_read", {
        artifact_id: result.full_message_artifact_id!,
        offset: tailOffset,
        max_bytes: 64,
      }) as { data: string | null; truncated: boolean };
      expect(page.data).toBeTruthy();
      expect(page.data!.startsWith("TAIL-")).toBe(true);

      // Outsider ACL refusal
      await expect(
        callBridgeTool(
          { ...ctx, coordinatorId: h.seed.outsiderId },
          "agent_artifact_read",
          { artifact_id: result.full_message_artifact_id! },
        ),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

      const events = h.core.turnEvents(h.seed.coordinatorId, t1.turn_id, 0, 200);
      const payloads = events.map((e) => e.payload ?? "");
      expect(payloads.every((p) => !/reasoning|thinking/i.test(p))).toBe(true);
      expect(payloads.every((p) => !p.includes(longTail))).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it("binds reviewer findings to baseline/target; next worker reads artifact id only", async () => {
    const h = createHarness();
    try {
      insertWorkspace(h.db, {
        workspace_id: "ws-review",
        project_id: h.seed.projectId,
        mode: "review_slot",
        canonical_path: null,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: h.seed.coverageProfileId,
      });
      const worker = await h.spawnWorkerSession();
      const s1 = h.core.snapshot(h.seed.coordinatorId, { project_id: h.seed.projectId, workspace_id: h.seed.workspaceMain, idempotency_key: "manual-report-baseline" }).snapshot_id;
      h.writeWorkspaceFile("src/main.c", "int main(){return 1;}\n");
      const target = h.core.snapshot(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        workspace_id: h.seed.workspaceMain,
        idempotency_key: "rep-target-1",
      });
      expect(target.capture_state).toBe("SEALED");
      const s2 = target.snapshot_id;

      const reviewer = await h.spawnWorkerSession({
        role: "reviewer",
        workspace: { mode: "review_slot", workspace_id: "ws-review" },
        access: "read_only",
      });
      const findingsText = "FINDINGS_BODY_exact_binding_ok";
      const tRev = h.core.send(h.seed.coordinatorId, {
        session_id: reviewer.session_id,
        idempotency_key: "rep-r1",
        task: {
          goal: "Review S1/S2.",
          acceptance_criteria: ["findings with refs"],
          artifact_refs: [],
        },
        review_binding: { baseline_snapshot_id: s1, target_snapshot_id: s2 },
      });
      h.adapter.plan(tRev.turn_id, [{ kind: "complete", outcome: "completed", summary: findingsText }]);
      await start(h, tRev);
      await settle(h);

      const ctx = {
        core: h.core,
        coordinatorId: h.seed.coordinatorId,
        daemonState: null,
        incarnation: "test",
      };
      const result = await callBridgeTool(ctx, "agent_turn_result", { turn_id: tRev.turn_id }) as {
        full_message_artifact_id: string;
        artifacts: Array<{ kind: string }>;
        summary_truncated: boolean;
      };
      expect(result.summary_truncated).toBe(false);
      expect(result.artifacts[0]?.kind).toBe("findings");

      const pub = getTurnEventPayload(h.db, tRev.turn_id, "report_publication");
      expect(pub?.baseline_snapshot_id).toBe(s1);
      expect(pub?.target_snapshot_id).toBe(s2);

      const page = await callBridgeTool(ctx, "agent_artifact_read", {
        artifact_id: result.full_message_artifact_id,
        offset: 0,
        max_bytes: 4096,
      }) as { data: string };
      const parsed = JSON.parse(page.data) as {
        baseline_snapshot_id: string;
        target_snapshot_id: string;
        text: string;
      };
      expect(parsed.baseline_snapshot_id).toBe(s1);
      expect(parsed.target_snapshot_id).toBe(s2);
      expect(parsed.text).toBe(findingsText);

      // Next mock worker consumes the findings artifact by ID only.
      const next = h.sendTask(worker.session_id, "rep-w2", "Apply findings.", {
        task: {
          goal: "Apply findings.",
          artifact_refs: [result.full_message_artifact_id],
          acceptance_criteria: [],
        },
      });
      h.adapter.plan(next.turn_id, [{ kind: "complete", outcome: "completed", summary: "applied-via-id" }]);
      await start(h, next);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, next.turn_id).state).toBe("SUCCEEDED");
    } finally {
      h.cleanup();
    }
  });

  it("known native complete then publication disk failure => EVIDENCE_CAPTURE_FAILED", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const t1 = h.sendTask(spawn.session_id, "rep-fail-1", "Report.");
      h.executor.failReportPublicationForTest(t1.turn_id);
      h.adapter.plan(t1.turn_id, [{ kind: "complete", outcome: "completed", summary: "native-done" }]);
      await start(h, t1);
      await settle(h);
      const turn = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("EVIDENCE_CAPTURE_FAILED");
      expect(turn.native_outcome).toBe("completed");
    } finally {
      h.cleanup();
    }
  });

  it("a failed durable report marker rolls back the known outcome instead of recovering false success", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const turn = h.sendTask(spawn.session_id, "atomic-final-marker", "Report.");
      h.db.raw.exec(`CREATE TRIGGER fail_report_marker BEFORE UPDATE OF payload ON intents
        WHEN json_extract(NEW.payload, '$.report.phase') = 'declared'
        BEGIN SELECT RAISE(ABORT, 'injected report marker failure'); END`);
      h.adapter.plan(turn.turn_id, [{ kind: "complete", outcome: "completed", summary: "required final" }]);
      await start(h, turn);
      await settle(h);
      expect(h.db.raw.prepare("SELECT * FROM turn_outcome_evidence WHERE turn_id = ?").get(turn.turn_id)).toBeUndefined();
      expect(reportSubjournal(h, turn.turn_id)).toBeNull();
      await h.executor.reconcileJournaledOutcomes();
      expect(turnStatus(h, turn.turn_id).state).toBe("FAILED");
      expect(turnStatus(h, turn.turn_id).native_outcome).toBe("completed");
    } finally { h.cleanup(); }
  });

  it("a completed result arriving after UNKNOWN cannot publish a report or release retained pins", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const turn = h.sendTask(spawn.session_id, "late-final-unknown", "Report.");
      h.db.raw.exec(`CREATE TRIGGER crash_on_progress AFTER INSERT ON events
        WHEN NEW.type = 'adapter:progress' AND json_extract(NEW.payload, '$.label') = 'status:running'
        BEGIN UPDATE turns SET state = 'UNKNOWN', native_outcome = 'unknown', state_version = state_version + 1 WHERE turn_id = NEW.turn_id;
        UPDATE sessions SET state = 'BLOCKED', record_version = record_version + 1 WHERE session_id = NEW.session_id; END`);
      h.adapter.plan(turn.turn_id, [{ kind: "progress", label: "status:running" },
        { kind: "complete", outcome: "completed", summary: "late native final" }]);
      await start(h, turn);
      await settle(h);
      expect(turnStatus(h, turn.turn_id).state).toBe("UNKNOWN");
      expect(getTurnEventPayload(h.db, turn.turn_id, "report_publication")).toBeNull();
      expect(reportSubjournal(h, turn.turn_id)).toBeNull();
      expect(listPinsByOwner(h.db, turn.turn_id).length).toBeGreaterThan(0);
    } finally { h.cleanup(); }
  });

  it("crash after blob before seal stops execution and reconciles without inference; replay keeps same artifact ID", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const t1 = h.sendTask(spawn.session_id, "rep-seal-1", "Report.");
      h.executor.skipReportSealForTest(t1.turn_id);
      h.adapter.plan(t1.turn_id, [{ kind: "complete", outcome: "completed", summary: "seal-later" }]);
      await h.executor.completeWithoutCommitForTest(t1.turn_id);

      // Real interruption: the turn never reached a terminal state while the
      // required report was unsealed (no terminal success with staging artifact).
      expect(turnStatus(h, t1.turn_id).state).not.toBe("SUCCEEDED");
      const pub = getTurnEventPayload(h.db, t1.turn_id, "report_publication");
      expect(pub?.phase).toBe("blob_written");
      const artifactId = pub?.artifact_id as string;
      expect(getArtifact(h.db, artifactId)?.state).toBe("staging");
      // The journaled native outcome already guards recovery before publication.
      const evidence = h.db.raw
        .prepare("SELECT candidate, native_outcome, applied FROM turn_outcome_evidence WHERE turn_id = ?")
        .get(t1.turn_id) as { candidate: string; native_outcome: string; applied: number };
      expect(evidence.candidate).toBe("SUCCEEDED");
      expect(evidence.applied).toBe(0);

      await h.executor.reconcileJournaledOutcomes();
      expect(getArtifact(h.db, artifactId)?.state).toBe("sealed");
      expect(turnStatus(h, t1.turn_id).state).toBe("SUCCEEDED");

      const pub2 = getTurnEventPayload(h.db, t1.turn_id, "report_publication");
      expect(pub2?.artifact_id).toBe(artifactId);
      expect(pub2?.phase).toBe("sealed");

      // Replay publication is idempotent — same artifact ID.
      const reported = getTurnEventPayload(h.db, t1.turn_id, "agent_reported");
      expect(reported?.full_message_artifact_id).toBe(artifactId);
    } finally {
      h.cleanup();
    }
  });

  it("crash after allocation before blob write recovers as EVIDENCE_CAPTURE_FAILED, preserving the completed native outcome", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const t1 = h.sendTask(spawn.session_id, "rep-noblob-1", "Report.");
      h.executor.skipReportBlobForTest(t1.turn_id);
      h.adapter.plan(t1.turn_id, [{ kind: "complete", outcome: "completed", summary: "never-written" }]);
      await h.executor.completeWithoutCommitForTest(t1.turn_id);

      const sub = reportSubjournal(h, t1.turn_id);
      expect(sub?.phase).toBe("allocated");
      const artifactId = sub?.artifact_id as string;
      expect(getArtifact(h.db, artifactId)?.state).toBe("staging");
      const pinned = listPinsByOwner(h.db, t1.turn_id).filter((p) => p.root_kind === "pending_intent");
      expect(pinned.length).toBe(1);

      await h.executor.reconcileJournaledOutcomes();
      const turn = turnStatus(h, t1.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("EVIDENCE_CAPTURE_FAILED");
      expect(turn.native_outcome).toBe("completed"); // never invented or UNKNOWN

      // Bounded lifetime: the unsealable staging tombstone expires, no pin leaks.
      expect(getArtifact(h.db, artifactId)?.state).toBe("expired");
      expect(listPinsByOwner(h.db, t1.turn_id).filter((p) => p.root_kind === "pending_intent").length).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  it("corrupt staged blob at recovery yields EVIDENCE_CAPTURE_FAILED with the native outcome preserved", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const t1 = h.sendTask(spawn.session_id, "rep-corrupt-1", "Report.");
      h.executor.skipReportSealForTest(t1.turn_id);
      h.adapter.plan(t1.turn_id, [{ kind: "complete", outcome: "completed", summary: "tampered-later" }]);
      await h.executor.completeWithoutCommitForTest(t1.turn_id);

      const pub = getTurnEventPayload(h.db, t1.turn_id, "report_publication");
      const artifactId = pub?.artifact_id as string;
      const hash = pub?.content_hash as string;
      expect(getArtifact(h.db, artifactId)?.state).toBe("staging");
      // Same byte length, different content: size passes, hash must refuse.
      // Same byte length, different content: size passes, hash must refuse.
      writeFileSync(blobFilePath(h, hash), Buffer.from("TAMPERED-LATER", "utf8"));

      await h.executor.reconcileJournaledOutcomes();
      const turn = turnStatus(h, t1.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("EVIDENCE_CAPTURE_FAILED");
      expect(turn.finalization_error).toContain("BLOB_HASH_MISMATCH");
      expect(turn.native_outcome).toBe("completed");
      // The corrupt artifact is never sealed.
      expect(getArtifact(h.db, artifactId)?.state).not.toBe("sealed");
    } finally {
      h.cleanup();
    }
  });

  it("foreign artifact binding at recovery refuses to seal and preserves the native outcome", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const t1 = h.sendTask(spawn.session_id, "rep-foreign-1", "Report.");
      h.executor.skipReportSealForTest(t1.turn_id);
      h.adapter.plan(t1.turn_id, [{ kind: "complete", outcome: "completed", summary: "foreign-bound" }]);
      await h.executor.completeWithoutCommitForTest(t1.turn_id);

      const artifactId = getTurnEventPayload(h.db, t1.turn_id, "report_publication")?.artifact_id as string;
      // Move the artifact to a foreign project between crash and recovery.
      h.db.raw.prepare("UPDATE artifacts SET project_id = 'project-foreign' WHERE artifact_id = ?").run(artifactId);

      await h.executor.reconcileJournaledOutcomes();
      const turn = turnStatus(h, t1.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("EVIDENCE_CAPTURE_FAILED");
      expect(turn.native_outcome).toBe("completed");
      // Unrelated evidence still recovers: a second healthy turn on the project settles.
      const t2 = h.sendTask(spawn.session_id, "rep-foreign-2", "Healthy.");
      h.adapter.plan(t2.turn_id, [{ kind: "complete", outcome: "completed", summary: "fine" }]);
      await start(h, t2);
      await settle(h);
      expect(turnStatus(h, t2.turn_id).state).toBe("SUCCEEDED");
    } finally {
      h.cleanup();
    }
  });

  it("stale incarnation cannot reconcile a staged report; the owning incarnation seals with the same ID", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const t1 = h.sendTask(spawn.session_id, "rep-stale-1", "Report.");
      h.executor.skipReportSealForTest(t1.turn_id);
      h.adapter.plan(t1.turn_id, [{ kind: "complete", outcome: "completed", summary: "fenced" }]);
      h.executor.attachIncarnation("live-inc");
      await h.executor.completeWithoutCommitForTest(t1.turn_id);

      const artifactId = getTurnEventPayload(h.db, t1.turn_id, "report_publication")?.artifact_id as string;
      h.db.raw
        .prepare("INSERT INTO daemon_state (id, daemon_state, incarnation, started_at) VALUES (1, 'ready', 'newer-inc', 1)")
        .run();

      // Stale reconcile mutates nothing: artifact stays staged, turn nonterminal.
      await h.executor.reconcileJournaledOutcomes();
      expect(getArtifact(h.db, artifactId)?.state).toBe("staging");
      expect(turnStatus(h, t1.turn_id).state).not.toBe("SUCCEEDED");
      expect(turnStatus(h, t1.turn_id).state).not.toBe("FAILED");

      // The owning incarnation reconciles and seals the SAME artifact ID.
      h.db.raw.prepare("UPDATE daemon_state SET incarnation = 'live-inc' WHERE id = 1").run();
      await h.executor.reconcileJournaledOutcomes();
      expect(getArtifact(h.db, artifactId)?.state).toBe("sealed");
      expect(turnStatus(h, t1.turn_id).state).toBe("SUCCEEDED");
      expect(getTurnEventPayload(h.db, t1.turn_id, "agent_reported")?.full_message_artifact_id).toBe(artifactId);
    } finally {
      h.cleanup();
    }
  });

  it("oversized declared final is rejected before any allocation; native outcome preserved", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const t1 = h.sendTask(spawn.session_id, "rep-big-1", "Huge report.");
      h.adapter.plan(t1.turn_id, [
        { kind: "complete", outcome: "completed", summary: "R" + "x".repeat(8 * 1024 * 1024) },
      ]);
      await start(h, t1);
      await settle(h);

      const turn = turnStatus(h, t1.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("EVIDENCE_CAPTURE_FAILED");
      expect(turn.native_outcome).toBe("completed");
      // No artifact or blob was ever allocated for the oversized final.
      const artCount = h.db.raw
        .prepare("SELECT COUNT(*) c FROM artifacts WHERE project_id = ? AND kind = 'report'")
        .get(h.seed.projectId) as { c: number };
      expect(artCount.c).toBe(0);
      expect(getTurnEventPayload(h.db, t1.turn_id, "report_publication")).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it("crash after seal before the result event recovers metadata from the subjournal with the same ID", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const t1 = h.sendTask(spawn.session_id, "rep-meta-1", "Report.");
      h.executor.skipReportSealForTest(t1.turn_id);
      h.adapter.plan(t1.turn_id, [{ kind: "complete", outcome: "completed", summary: "sealed-no-meta" }]);
      await h.executor.completeWithoutCommitForTest(t1.turn_id);

      // Torn window simulation: the seal settled (artifact + pin + sealed event +
      // subjournal phase) but the process died before the bounded result event.
      const pub = getTurnEventPayload(h.db, t1.turn_id, "report_publication");
      const artifactId = pub?.artifact_id as string;
      sealArtifact(h.db, artifactId, pub?.content_hash as string, pub?.size_bytes as number, 5_000);
      insertPin(h.db, {
        pin_id: "pin-meta-recovery",
        artifact_id: artifactId,
        root_kind: "active_turn",
        owner_session_id: spawn.session_id,
        owner_turn_id: t1.turn_id,
        created_at: 5_000,
      });
      appendSealedEvent(h, t1.turn_id, spawn.session_id, pub ?? {});
      const intent = h.db.raw
        .prepare("SELECT intent_id, payload FROM intents WHERE kind='launch_turn' AND state='pending' AND turn_id=?")
        .get(t1.turn_id) as { intent_id: string; payload: string };
      const parsed = JSON.parse(intent.payload) as { report: Record<string, unknown> };
      parsed.report.phase = "sealed";
      h.db.raw.prepare("UPDATE intents SET payload = ? WHERE intent_id = ?").run(JSON.stringify(parsed), intent.intent_id);

      await h.executor.reconcileJournaledOutcomes();
      expect(turnStatus(h, t1.turn_id).state).toBe("SUCCEEDED");
      const reported = getTurnEventPayload(h.db, t1.turn_id, "agent_reported");
      expect(reported?.full_message_artifact_id).toBe(artifactId);
      expect(reported?.summary).toBe("sealed-no-meta");
    } finally {
      h.cleanup();
    }
  });

  it("sealed publication recovery verifies the actual blob before reconstructing a successful result", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const turn = h.sendTask(spawn.session_id, "sealed-corrupt-recovery", "Report.");
      h.executor.skipCommitForTest(turn.turn_id);
      h.adapter.plan(turn.turn_id, [{ kind: "complete", outcome: "completed", summary: "durable report" }]);
      await start(h, turn);
      await settle(h);
      const sub = reportSubjournal(h, turn.turn_id)!;
      expect(sub.phase).toBe("sealed");
      writeFileSync(path.join(h.blobRoot, h.seed.projectId, (sub.content_hash as string).slice(0, 2), sub.content_hash as string), "corrupt");
      await h.executor.reconcileJournaledOutcomes();
      expect(turnStatus(h, turn.turn_id).error_code).toBe("EVIDENCE_CAPTURE_FAILED");
      expect(turnStatus(h, turn.turn_id).native_outcome).toBe("completed");
    } finally { h.cleanup(); }
  });

  it("malformed required report metadata cannot disappear into a successful recovery", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const turn = h.sendTask(spawn.session_id, "corrupt-report-schema", "Report.");
      h.executor.skipReportBlobForTest(turn.turn_id);
      h.adapter.plan(turn.turn_id, [{ kind: "complete", outcome: "completed", summary: "required final" }]);
      await start(h, turn);
      await settle(h);
      const artifactId = reportSubjournal(h, turn.turn_id)!.artifact_id as string;
      h.db.raw.prepare("UPDATE intents SET payload = json_set(payload, '$.report.format_status', 'corrupt') WHERE turn_id = ? AND kind = 'launch_turn'").run(turn.turn_id);
      await h.executor.reconcileJournaledOutcomes();
      expect(turnStatus(h, turn.turn_id).state).toBe("FAILED");
      expect(turnStatus(h, turn.turn_id).error_code).toBe("EVIDENCE_CAPTURE_FAILED");
      expect(turnStatus(h, turn.turn_id).native_outcome).toBe("completed");
      expect(getArtifact(h.db, artifactId)?.state).toBe("expired");
    } finally { h.cleanup(); }
  });

  it("claim metadata is projected and byte bounded before the durable intent write", async () => {
    const h = createHarness();
    try {
      const execute = h.adapter.executeTurn.bind(h.adapter);
      h.adapter.executeTurn = async (...args) => {
        const result = await execute(...args);
        result.agent_reported = {
          summary: "declared final", format_status: "structured",
          claimed_checks: Array.from({ length: 100 }, () => ({ name: "offline test", details: "x".repeat(100_000), raw: "private_reasoning_marker" })),
        };
        return result;
      };
      const spawn = await h.spawnWorkerSession();
      const turn = h.sendTask(spawn.session_id, "bounded-claim-metadata", "Report.");
      await start(h, turn);
      await settle(h);
      expect(turnStatus(h, turn.turn_id).state).toBe("SUCCEEDED");
      const intent = h.db.raw.prepare("SELECT payload FROM intents WHERE kind='launch_turn' AND turn_id=?").get(turn.turn_id) as { payload: string };
      expect(Buffer.byteLength(intent.payload)).toBeLessThan(64 * 1024);
      expect(intent.payload).not.toContain("private_reasoning_marker");
      const reported = getTurnEventPayload(h.db, turn.turn_id, "agent_reported")!;
      expect(JSON.stringify(reported)).not.toContain("private_reasoning_marker");
      expect((reported.claimed_checks as unknown[]).length).toBeLessThan(32);
    } finally { h.cleanup(); }
  });

  it("latest worker report and reviewer findings survive cleanup until replacement or close", async () => {
    const h = createHarness();
    try {
      const worker = await h.spawnWorkerSession();
      const t1 = h.sendTask(worker.session_id, "rep-pin-1", "Report.");
      h.adapter.plan(t1.turn_id, [{ kind: "complete", outcome: "completed", summary: "pinned-then-free" }]);
      await start(h, t1);
      await settle(h);
      const reportId = getTurnEventPayload(h.db, t1.turn_id, "report_publication")?.artifact_id as string;
      expect(getArtifact(h.db, reportId)?.state).toBe("sealed");
      // Completed worker report: no publication pins leak (the surviving
      // turn-owned pin retains the latest report only).
      const workerTurnPins = listPinsByOwner(h.db, t1.turn_id);
      expect(workerTurnPins.filter((p) => p.root_kind === "active_turn" || p.root_kind === "pending_intent").length).toBe(0);
      expect(workerTurnPins.map((p) => p.root_kind)).toEqual(["session_anchor"]);
      // The latest report survives while the open session references it.
      const preview = previewCleanup(h.db, openBlobStore(h.blobRoot), h.seed.projectId);
      expect(preview.eligible.some((a) => a.artifact_id === reportId)).toBe(false);
      const t2 = h.sendTask(worker.session_id, "rep-pin-2", "Next report.");
      h.adapter.plan(t2.turn_id, [{ kind: "complete", outcome: "completed", summary: "latest-report" }]);
      await start(h, t2);
      await settle(h);
      const nextId = getTurnEventPayload(h.db, t2.turn_id, "report_publication")?.artifact_id as string;
      const replacement = previewCleanup(h.db, openBlobStore(h.blobRoot), h.seed.projectId);
      expect(replacement.eligible.some((a) => a.artifact_id === reportId)).toBe(true);
      expect(replacement.eligible.some((a) => a.artifact_id === nextId)).toBe(false);

      // Reviewer findings stay anchored until session close.
      insertWorkspace(h.db, {
        workspace_id: "ws-review-pin",
        project_id: h.seed.projectId,
        mode: "review_slot",
        canonical_path: null,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: h.seed.coverageProfileId,
      });
      const reviewer = await h.spawnWorkerSession({
        role: "reviewer",
        workspace: { mode: "review_slot", workspace_id: "ws-review-pin" },
        access: "read_only",
      });
      const manual = h.core.snapshot(h.seed.coordinatorId, { project_id: h.seed.projectId, workspace_id: h.seed.workspaceMain, idempotency_key: "manual-report-pins" }).snapshot_id;
      const tRev = h.sendTask(reviewer.session_id, "rep-pin-rev", "Review.", {
        review_binding: {
          baseline_snapshot_id: manual,
          target_snapshot_id: manual,
        },
      });
      h.adapter.plan(tRev.turn_id, [{ kind: "complete", outcome: "completed", summary: "anchored-findings" }]);
      await start(h, tRev);
      await settle(h);
      const findingsId = getTurnEventPayload(h.db, tRev.turn_id, "report_publication")?.artifact_id as string;
      expect(getArtifact(h.db, findingsId)?.state).toBe("sealed");
      expect(listPinsByOwner(h.db, reviewer.session_id).some((p) => p.root_kind === "reviewer_anchor")).toBe(true);
      const preview2 = previewCleanup(h.db, openBlobStore(h.blobRoot), h.seed.projectId);
      expect(preview2.eligible.some((a) => a.artifact_id === findingsId)).toBe(false);

      // Close releases owned reviewer anchors (phase 2 completes via drain);
      // expiry then becomes explicit.
      h.core.stop(h.seed.coordinatorId, { session_id: reviewer.session_id, idempotency_key: "stop-rev" });
      await settle(h);
      expect(listPinsByOwner(h.db, reviewer.session_id).some((p) => p.root_kind === "reviewer_anchor")).toBe(false);
      const result = executeCleanup(h.db, openBlobStore(h.blobRoot), h.seed.projectId, { artifact_ids: [reportId, findingsId] }, 999_999);
      expect(result.expiredArtifactIds.sort()).toEqual([findingsId, reportId].sort());
    } finally {
      h.cleanup();
    }
  });

  it("private reasoning, unknown event types and payload extras never persist; schema labels do", async () => {
    // Unit: the sanitizer drops thinking/reasoning, unknown types and extras.
    expect(sanitizeAdapterEvent({ type: "thinking", payload: { text: "private reasoning" } })).toBeNull();
    expect(sanitizeAdapterEvent({ type: "reasoning", payload: {} })).toBeNull();
    expect(sanitizeAdapterEvent({ type: "mystery_stream", payload: { raw: "arbitrary" } })).toBeNull();
    expect(sanitizeAdapterEvent({ type: "progress", payload: { label: "private_reasoning" } })).toBeNull();
    expect(sanitizeAdapterEvent({ type: "hook_audit", payload: { toolkind: "private reasoning", status: "private reasoning", raw: "secret" } }))
      .toEqual({ type: "hook_audit", payload: { toolkind: "unknown", status: "unknown" } });
    expect(sanitizeAdapterEvent({ type: "owned_zero_resume", payload: { ownership: { root_pid: 123, raw: "private reasoning" }, quiesced: false, raw: "private reasoning" } }))
      .toEqual({ type: "owned_zero_resume", payload: { ownership: { root_pid: 123 }, quiesced: false } });
    expect(sanitizeAdapterEvent({ type: "owned_quiescence", payload: { op: "terminated", root_exit_code: 17, active: 0, drained: true, raw: "private reasoning" } }))
      .toEqual({ type: "owned_quiescence", payload: { op: "terminated", root_exit_code: 17, active: 0, drained: true } });
    expect(sanitizeAdapterEvent({ type: "progress", payload: { label: "tool_call:read", extra: "private" } }))
      .toEqual({ type: "progress", payload: { label: "tool_call:read" } });
    expect(sanitizeAdapterEvent({ type: "progress", payload: { label: "This is prose" } })).toBeNull();
    expect(sanitizeAdapterEvent({ type: "owned_zero_resume", payload: { ownership: null, quiesced: false } }))
      .toEqual({ type: "owned_zero_resume", payload: { ownership: null, quiesced: false } });

    // Integration: mixed-case tokens are dropped, schema labels persist.
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const t1 = h.sendTask(spawn.session_id, "rep-labels-1", "Labels.");
      h.adapter.plan(t1.turn_id, [
        { kind: "progress", label: "PrivateReasoningToken" },
        { kind: "progress", label: "tick-1" },
        { kind: "progress", label: "tool_call:read" },
        { kind: "progress", label: "status:assistant_text" },
        { kind: "complete", outcome: "completed", summary: "labels-done" },
      ]);
      await start(h, t1);
      await settle(h);
      expect(turnStatus(h, t1.turn_id).state).toBe("SUCCEEDED");
      const labels = h.core.turnEvents(h.seed.coordinatorId, t1.turn_id, 0, 200)
        .filter((e) => e.type === "adapter:progress")
        .map((e) => (JSON.parse(e.payload as string) as { label: string }).label);
      expect(labels).toEqual(["tool_call:read", "status:assistant_text"]);
    } finally {
      h.cleanup();
    }
  });

  it("pins retained on UNKNOWN; no reasoning marker in persisted events", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const t1 = h.sendTask(spawn.session_id, "rep-unk-1", "Hang then unknown.");
      h.adapter.plan(t1.turn_id, [
        { kind: "progress", label: "tool_call:read" },
        { kind: "barrier", name: "hold" },
        { kind: "complete", outcome: "completed", summary: "should-not-matter" },
      ]);
      await start(h, t1);
      await h.executor.forceUnknownForTest(t1.turn_id, new Error("supervisor crash"));
      const turn = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turn.state).toBe("UNKNOWN");
      const pins = listPinsByOwner(h.db, t1.turn_id);
      expect(pins.length).toBeGreaterThan(0);
      const events = h.core.turnEvents(h.seed.coordinatorId, t1.turn_id, 0, 200);
      for (const e of events) {
        expect(e.type).not.toMatch(/thinking|reasoning/i);
        if (e.payload) expect(e.payload).not.toMatch(/reasoning.marker|private reasoning/i);
      }
    } finally {
      h.cleanup();
    }
  });
});

function appendSealedEvent(
  h: ReturnType<typeof createHarness>,
  turnId: string,
  sessionId: string,
  pub: Record<string, unknown>,
): void {
  h.db.raw
    .prepare(
      "INSERT INTO events (turn_id, session_id, type, payload, created_at) VALUES (?, ?, 'report_publication', ?, ?)",
    )
    .run(turnId, sessionId, JSON.stringify({ ...pub, phase: "sealed", sealed_at: 5_000 }), 5_000);
}
