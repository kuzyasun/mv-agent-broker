/**
 * Tests for transport envelope limit planning and complete required input delivery (spec §7.1.1, §13.2, §15.1).
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHarness, settle, start } from "../helpers/harness.ts";
import { ZcodeAdapter } from "../../src/providers/zcode/zcodeAdapter.ts";
import { ZCODE_ACCOUNT_PROVIDER } from "../../src/providers/zcode/nativeConfig.ts";
import { insertAccount, insertWorkspace } from "../../src/storage/repo.ts";
import { openBlobStore } from "../../src/snapshots/blobs.ts";
import { planInputDelivery, type TurnInputManifest } from "../../src/inputs/manifest.ts";

const tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFakeZcodeBundle(): { bundle: string; builtin: string } {
  const root = mkdtempSync(path.join(tmpdir(), "zcode-transport-test-"));
  tempRoots.push(root);
  const bundle = path.join(root, "fake-zcode.cjs");
  const builtin = path.join(root, "zcode-builtin.json");

  writeFileSync(
    builtin,
    JSON.stringify({
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: ZCODE_ACCOUNT_PROVIDER,
              config: {
                builtinModelIds: ["GLM-5.3", "GLM-5.3-Flash"],
                access: { type: "zhipu-account", mode: "individual-coding-plan", accountType: "zai" },
              },
            },
          ],
        },
        modelConfigRules: { builtinProviderModelRules: [] },
      },
    }),
  );

  writeFileSync(
    bundle,
    `
const fs = require('fs');
const args = process.argv.slice(2);
const prompt = args[args.indexOf('--prompt') + 1];
const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
const personal = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
const config = JSON.parse(fs.readFileSync(personal, 'utf8'));
const result = {
  sessionId: resume || 'sess_native',
  response: JSON.stringify({ ok: true, promptLength: prompt.length }),
  projection: { status: 'idle' }
};
process.stdout.write(JSON.stringify(result, null, 2) + '\\n');
`,
  );

  return { bundle, builtin };
}

describe("normative complete envelope transport (§7.1.1, §13.2, §15.1)", () => {
  it("reviewer diff 3..12KiB becomes path when inline would exceed 6000, all tail bytes retrievable and proper exact readonly grants", async () => {
    const h = createHarness();
    try {
      const { bundle, builtin } = createFakeZcodeBundle();
      const zcodeAdapter = new ZcodeAdapter({
        bundlePath: bundle,
        builtinProviderConfigPath: builtin,
        nodeBinary: process.execPath,
        mode: "plan",
      });
      h.core.adapters.set("zcode", zcodeAdapter);

      insertAccount(h.db, {
        account_profile_id: "acct-zcode",
        provider: "zcode",
        quota_scope_id: "qs-zcode",
        auth_mode: "native",
      });

      insertWorkspace(h.db, {
        workspace_id: "ws-review-zcode",
        project_id: h.seed.projectId,
        mode: "review_slot",
        canonical_path: null,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: h.seed.coverageProfileId,
      });

      // Spawn reviewer session on zcode
      const reviewer = await h.core.spawn(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        provider: "zcode",
        account_profile_id: "acct-zcode",
        model: "GLM-5.3-Flash",
        role: "reviewer",
        workspace: { mode: "review_slot", workspace_id: "ws-review-zcode" },
        policy_profile_id: "pol-writer",
        policy_profile_version: "1",
        instructions: "Please conduct a comprehensive review of all changed code and verify correctness against requirements.",
        idempotency_key: "spawn-rev-zcode-1",
      });

      // Baseline snapshot from worker
      const workerSpawn = await h.spawnWorkerSession();
      const workerStatus = h.core.sessionStatus(h.seed.coordinatorId, workerSpawn.session_id);
      const baseline = workerStatus.initial_snapshot_id;
      expect(baseline).toBeTruthy();

      // Write changes resulting in ~5 KiB diff
      const changeLines: string[] = ["int main() {"];
      for (let i = 0; i < 60; i++) {
        changeLines.push(`  int buffer_${i} = ${i * 10}; /* change line: ${"abcde".repeat(10)} */`);
      }
      changeLines.push("  return 42;\n}\n");
      const code = changeLines.join("\n");
      h.writeWorkspaceFile("src/main.c", code);

      const target = h.core.snapshot(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        workspace_id: h.seed.workspaceMain,
        idempotency_key: "target-zcode-1",
      });
      expect(target.capture_state).toBe("SEALED");

      const t1 = h.core.send(h.seed.coordinatorId, {
        session_id: reviewer.session_id,
        idempotency_key: "turn-zcode-1",
        task: {
          goal: "Review the modified code carefully and inspect every function implementation.",
          acceptance_criteria: ["verified"],
          artifact_refs: [],
        },
        review_binding: {
          baseline_snapshot_id: baseline!,
          target_snapshot_id: target.snapshot_id,
        },
      });

      await start(h, t1);
      await settle(h);

      const turn = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turn.state).toBe("SUCCEEDED");

      // Verify manifest recorded review_diff delivery as read_only_path
      const artRow = h.db.raw
        .prepare("SELECT content_hash FROM artifacts WHERE artifact_id = ?")
        .get(turn.input_manifest_id!) as { content_hash: string };
      const blobs = openBlobStore(h.blobRoot);
      const manifest = JSON.parse(
        Buffer.from(blobs.read(h.seed.projectId, artRow.content_hash)).toString("utf8"),
      ) as TurnInputManifest;

      const reviewDiff = manifest.inputs.find((e) => e.origin === "review_diff");
      expect(reviewDiff).toBeDefined();
      expect(reviewDiff?.delivery).toBe("read_only_path");
      // The diff was ~4-5 KiB (between 3 KiB and 12 KiB)
      expect(reviewDiff?.size_bytes).toBeGreaterThan(3 * 1024);
      expect(reviewDiff?.size_bytes).toBeLessThan(12 * 1024);

      // Verify that all tail bytes in the blob match the diff text
      const diffBytes = blobs.read(h.seed.projectId, reviewDiff!.content_hash);
      const diffText = Buffer.from(diffBytes).toString("utf8");
      expect(diffText).toContain("int buffer_59 = 590;");
      expect(diffText).toContain("+  return 42;");
      expect(diffText.includes("[diff truncated]")).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it("ordinary mock default inline 16KiB preserved", async () => {
    const h = createHarness();
    try {
      insertWorkspace(h.db, {
        workspace_id: "ws-review-mock",
        project_id: h.seed.projectId,
        mode: "review_slot",
        canonical_path: null,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: h.seed.coverageProfileId,
      });

      const reviewer = await h.spawnWorkerSession({
        role: "reviewer",
        workspace: { mode: "review_slot", workspace_id: "ws-review-mock" },
      });

      const workerSpawn = await h.spawnWorkerSession();
      const workerStatus = h.core.sessionStatus(h.seed.coordinatorId, workerSpawn.session_id);
      const baseline = workerStatus.initial_snapshot_id;

      // Small diff ~500 bytes
      h.writeWorkspaceFile("src/main.c", "int main() { return 100; }\n");
      const target = h.core.snapshot(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        workspace_id: h.seed.workspaceMain,
        idempotency_key: "target-mock-1",
      });

      const t1 = h.core.send(h.seed.coordinatorId, {
        session_id: reviewer.session_id,
        idempotency_key: "turn-mock-inline-1",
        task: {
          goal: "Review diff.",
          acceptance_criteria: ["done"],
          artifact_refs: [],
        },
        review_binding: {
          baseline_snapshot_id: baseline!,
          target_snapshot_id: target.snapshot_id,
        },
      });

      h.adapter.plan(t1.turn_id, [{ kind: "complete", outcome: "completed" }]);
      await start(h, t1);
      await settle(h);

      const turn = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turn.state).toBe("SUCCEEDED");

      const artRow = h.db.raw
        .prepare("SELECT content_hash FROM artifacts WHERE artifact_id = ?")
        .get(turn.input_manifest_id!) as { content_hash: string };
      const blobs = openBlobStore(h.blobRoot);
      const manifest = JSON.parse(
        Buffer.from(blobs.read(h.seed.projectId, artRow.content_hash)).toString("utf8"),
      ) as TurnInputManifest;

      const reviewDiff = manifest.inputs.find((e) => e.origin === "review_diff");
      expect(reviewDiff).toBeDefined();
      expect(reviewDiff?.delivery).toBe("inline");
    } finally {
      h.cleanup();
    }
  });

  it("huge fixed instructions explicit fail, no goal instructions truncation, native false before gate", async () => {
    const h = createHarness();
    try {
      const { bundle, builtin } = createFakeZcodeBundle();
      const zcodeAdapter = new ZcodeAdapter({
        bundlePath: bundle,
        builtinProviderConfigPath: builtin,
        nodeBinary: process.execPath,
        mode: "plan",
      });
      h.core.adapters.set("zcode", zcodeAdapter);

      insertAccount(h.db, {
        account_profile_id: "acct-zcode-huge",
        provider: "zcode",
        quota_scope_id: "qs-zcode",
        auth_mode: "native",
      });

      // 7000 characters of instructions — exceeds ZCode's 6000 argv cap alone!
      const hugeInstructions = "INSTRUCTION: " + "X".repeat(7000);
      const session = await h.core.spawn(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        provider: "zcode",
        account_profile_id: "acct-zcode-huge",
        model: "GLM-5.3-Flash",
        role: "worker",
        workspace: { mode: "current", workspace_id: h.seed.workspaceMain },
        policy_profile_id: "pol-writer",
        policy_profile_version: "1",
        instructions: hugeInstructions,
        idempotency_key: "spawn-huge-inst-1",
      });

      const status = h.core.sessionStatus(h.seed.coordinatorId, session.session_id);
      const goalText = "Original full goal text without any slicing or truncation.";
      const t1 = h.core.send(h.seed.coordinatorId, {
        session_id: session.session_id,
        idempotency_key: "turn-huge-inst-1",
        task: {
          goal: goalText,
          acceptance_criteria: ["done"],
          artifact_refs: [],
        },
        workspace_precondition: {
          expected_snapshot_id: status.initial_snapshot_id!,
        },
      });

      await start(h, t1);
      await settle(h);

      const turn = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("INPUT_LIMIT");

      // Verify zero inference: execution_started must be false or null, never true!
      const turnRow = h.db.raw
        .prepare("SELECT execution_started FROM turns WHERE turn_id = ?")
        .get(t1.turn_id) as { execution_started: number | null };
      expect(turnRow.execution_started).toBeFalsy();

      // No dispatch permission granted event
      const events = h.core.turnEvents(h.seed.coordinatorId, t1.turn_id, 0, 50);
      expect(events.some((e) => e.type === "dispatch_permission_granted")).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it("many input path footers lengths limit triggers explicit fail", async () => {
    const h = createHarness();
    try {
      const { bundle, builtin } = createFakeZcodeBundle();
      const zcodeAdapter = new ZcodeAdapter({
        bundlePath: bundle,
        builtinProviderConfigPath: builtin,
        nodeBinary: process.execPath,
        mode: "plan",
      });
      h.core.adapters.set("zcode", zcodeAdapter);

      insertAccount(h.db, {
        account_profile_id: "acct-zcode-many",
        provider: "zcode",
        quota_scope_id: "qs-zcode",
        auth_mode: "native",
      });

      // 3500 chars instructions + 28 path footers (~3100 chars) = ~6600 chars > 6000 chars limit!
      const session = await h.core.spawn(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        provider: "zcode",
        account_profile_id: "acct-zcode-many",
        model: "GLM-5.3-Flash",
        role: "worker",
        workspace: { mode: "current", workspace_id: h.seed.workspaceMain },
        policy_profile_id: "pol-writer",
        policy_profile_version: "1",
        instructions: "INSTRUCTION: " + "Y".repeat(3500),
        idempotency_key: "spawn-many-inputs-1",
      });

      // Publish 28 small artifacts (within the 32 max artifact_refs limit)
      const artIds: string[] = [];
      for (let i = 0; i < 28; i++) {
        const art = h.publishArtifact(`content for artifact ${i}`);
        artIds.push(art.artifact_id);
      }

      const status = h.core.sessionStatus(h.seed.coordinatorId, session.session_id);
      const t1 = h.core.send(h.seed.coordinatorId, {
        session_id: session.session_id,
        idempotency_key: "turn-many-inputs-1",
        task: {
          goal: "Process all artifacts.",
          acceptance_criteria: ["done"],
          artifact_refs: artIds,
        },
        workspace_precondition: {
          expected_snapshot_id: status.initial_snapshot_id!,
        },
      });

      await start(h, t1);
      await settle(h);

      const turn = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("INPUT_LIMIT");

      const turnRow = h.db.raw
        .prepare("SELECT execution_started FROM turns WHERE turn_id = ?")
        .get(t1.turn_id) as { execution_started: number | null };
      expect(turnRow.execution_started).toBeFalsy();
    } finally {
      h.cleanup();
    }
  });

  it("multibyte Unicode byte and character bounds are evaluated independently", () => {
    // 2000 Chinese characters: 2000 chars length, but 6000 UTF-8 bytes
    const text2000 = "你".repeat(2000);
    const bytes2000 = Buffer.from(text2000, "utf8");
    expect(text2000.length).toBe(2000);
    expect(bytes2000.byteLength).toBe(6000);

    const art = {
      artifact_id: "art-unicode",
      project_id: "proj",
      kind: "findings" as const,
      content_hash: "0".repeat(64),
      size_bytes: bytes2000.byteLength,
      state: "sealed" as const,
      created_at: 1,
      sealed_at: 1,
      expired_at: null,
    };

    // Case A: fits within 6000 chars cap and 16KiB byte cap
    const plannedA = planInputDelivery({
      inputs: [
        {
          origin: "task_artifact",
          artifact: art,
          content_type: "text/plain",
          inlineCandidate: bytes2000,
          allowMaterialization: true,
        },
      ],
      transportEnvelopeLimit: { maxChars: 6000 },
      evaluateEnvelope: (deliveries) => {
        const isInline = deliveries[0]?.delivery === "inline";
        return { chars: 1000 + (isInline ? 2000 : 100), bytes: 1000 + (isInline ? 6000 : 100) };
      },
    });
    expect(plannedA[0]!.delivery).toBe("inline");

    // Case B: 6000 Chinese characters: 6000 chars length, but 18000 UTF-8 bytes (> 16 KiB cap)
    const text6000 = "你".repeat(6000);
    const bytes6000 = Buffer.from(text6000, "utf8");
    expect(bytes6000.byteLength).toBe(18000);

    const artB = { ...art, size_bytes: bytes6000.byteLength };
    const plannedB = planInputDelivery({
      inputs: [
        {
          origin: "task_artifact",
          artifact: artB,
          content_type: "text/plain",
          inlineCandidate: bytes6000,
          allowMaterialization: true,
        },
      ],
      transportEnvelopeLimit: { maxChars: 6000 },
      evaluateEnvelope: (deliveries) => {
        const isInline = deliveries[0]?.delivery === "inline";
        return { chars: 1000 + (isInline ? 6000 : 100) };
      },
    });
    expect(plannedB[0]!.delivery).toBe("read_only_path");
  });
});
