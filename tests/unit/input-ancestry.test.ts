import { expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openBlobStore } from "../../src/snapshots/blobs.ts";
import { openInputViewStore } from "../../src/inputs/views.ts";
import { openReviewSlotStore } from "../../src/workspaces/slot.ts";
import { sha256Hex } from "../../src/shared/ids.ts";
import type { SnapshotManifest } from "../../src/shared/api-types.ts";
import type { TurnInputManifest } from "../../src/inputs/manifest.ts";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "broker-input-ancestry-"));
  const physical = path.join(root, "physical");
  const alias = path.join(root, "alias");
  mkdirSync(physical);
  return { root, physical, alias, cleanup() {
    // Unlink the exact owned alias before removing the physical fixture.
    rmSync(alias, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  } };
}

function manifest(store: ReturnType<typeof openInputViewStore>, body: Buffer): TurnInputManifest {
  return {
    manifest_version: 1, turn_id: "turn-ancestry", session_id: "session-ancestry",
    policy_binding: { policy_profile_id: "p", policy_profile_version: "1" },
    workspace_binding: { workspace_id: "w", expected_snapshot_id: null },
    created_at: 1, manifest_hash: "fixture",
    inputs: [{ input_id: "in-1", origin: "task_artifact", artifact_id: "artifact-ancestry",
      content_hash: sha256Hex(body), content_type: "text/plain", size_bytes: body.length,
      delivery: "read_only_path", binding: path.join(store.turnRoot("turn-ancestry"), "in-1.txt"),
      access_enforcement: "enforced", lifetime: "turn_until_quiescence" }],
  };
}

it("verified blob rejects a linked ancestor above an ordinary store directory", (ctx) => {
  const f = fixture();
  try {
    const physicalStore = openBlobStore(path.join(f.physical, "blobs"));
    const blob = physicalStore.write("project", "known bytes");
    try { symlinkSync(f.physical, f.alias, process.platform === "win32" ? "junction" : "dir"); }
    catch { ctx.skip("directory link unavailable"); return; }
    const throughAlias = openBlobStore(path.join(f.alias, "blobs"));
    expect(() => throughAlias.readVerified("project", blob.hash, blob.size)).toThrow("BLOB_NOT_REGULAR");
    expect(Buffer.from(physicalStore.readVerified("project", blob.hash, blob.size)).toString()).toBe("known bytes");
  } finally { f.cleanup(); }
});

it("linked input ancestor refuses before callback or foreign turn-directory creation", (ctx) => {
  const f = fixture();
  try {
    mkdirSync(path.join(f.physical, "inputs"));
    try { symlinkSync(f.physical, f.alias, process.platform === "win32" ? "junction" : "dir"); }
    catch { ctx.skip("directory link unavailable"); return; }
    const store = openInputViewStore(path.join(f.alias, "inputs"));
    const body = Buffer.from("expected bytes");
    let calls = 0;
    expect(() => store.materialize(manifest(store, body), () => { calls++; return body; })).toThrow("INPUT_VIEW_PATH_INVALID");
    expect(calls).toBe(0);
    expect(existsSync(path.join(f.physical, "inputs", "turn-ancestry"))).toBe(false);
  } finally { f.cleanup(); }
});

it("linked input ancestor refuses cleanup and preserves the existing physical turn", (ctx) => {
  const f = fixture();
  try {
    const existing = path.join(f.physical, "inputs", "turn-ancestry");
    mkdirSync(existing, { recursive: true });
    writeFileSync(path.join(existing, "marker"), "retained");
    try { symlinkSync(f.physical, f.alias, process.platform === "win32" ? "junction" : "dir"); }
    catch { ctx.skip("directory link unavailable"); return; }
    expect(() => openInputViewStore(path.join(f.alias, "inputs")).cleanup("turn-ancestry")).toThrow("INPUT_VIEW_PATH_INVALID");
    expect(readFileSync(path.join(existing, "marker"), "utf8")).toBe("retained");
  } finally { f.cleanup(); }
});

it("linked slot ancestor refuses refresh and new slot creation without removing the old tree", (ctx) => {
  const f = fixture();
  try {
    const slot = path.join(f.physical, "slots", "session-ancestry");
    mkdirSync(slot, { recursive: true });
    writeFileSync(path.join(slot, "marker"), "retained");
    try { symlinkSync(f.physical, f.alias, process.platform === "win32" ? "junction" : "dir"); }
    catch { ctx.skip("directory link unavailable"); return; }
    const store = openReviewSlotStore(path.join(f.alias, "slots"));
    const body = Buffer.from("new tree");
    const snapshot: SnapshotManifest = {
      snapshot_id: "snapshot", project_id: "project", workspace_id: "workspace",
      coverage: { profile_id: "p", version: "1", contract_hash: "c" },
      entries: [{ path: "source.txt", type: "file", content_hash: sha256Hex(body), size: body.length, executable: false }],
      source_digest: "fixture", non_source_observed: [], protected_observed: [], excluded_observed: [],
      capture_consistency: "broker_exclusive", git_provenance: null, captured_at: 1,
    };
    expect(() => store.refresh("session-ancestry", snapshot, () => body)).toThrow("SLOT_PATH_INVALID");
    expect(() => store.slotPath("new-session")).toThrow("SLOT_PATH_INVALID");
    expect(readFileSync(path.join(slot, "marker"), "utf8")).toBe("retained");
    expect(existsSync(path.join(f.physical, "slots", "new-session"))).toBe(false);
  } finally { f.cleanup(); }
});
