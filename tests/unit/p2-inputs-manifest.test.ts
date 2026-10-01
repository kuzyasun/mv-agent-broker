/**
 * Unit tests for the TurnInputManifest module (spec §5.6, §7.1.1).
 */
import { describe, expect, it } from "vitest";
import type { ArtifactRecord } from "../../src/shared/api-types.ts";
import {
  buildTurnInputManifest,
  INLINE_TOTAL_BYTE_CAP,
  InputPlanError,
  planInputDelivery,
  verifyTurnInputManifest,
  type TurnInputManifest,
} from "../../src/inputs/manifest.ts";
import { sha256Hex } from "../../src/shared/ids.ts";

function makeArtifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    artifact_id: "art-1",
    project_id: "project-parser",
    kind: "findings",
    content_hash: sha256Hex("content"),
    size_bytes: 10,
    state: "sealed",
    created_at: 1,
    sealed_at: 1,
    expired_at: null,
    ...overrides,
  };
}

function textOf(bytes: number): Uint8Array {
  return new Uint8Array(bytes).fill(65);
}

describe("planInputDelivery delivery selection (§7.1.1)", () => {
  it("keeps short inline inputs when path bindings would exceed the transport cap", () => {
    for (const allowed of [true, false]) {
      const planned = planInputDelivery({
        inputs: [true, allowed].map((allowMaterialization, i) => ({
          origin: "task_artifact" as const, artifact: makeArtifact({ artifact_id: `art-${i}`, size_bytes: 1 }),
          content_type: "text/plain", inlineCandidate: textOf(1), allowMaterialization,
        })),
        transportEnvelopeLimit: { maxChars: 100 },
        evaluateEnvelope: ds => ({ chars: 50 + ds.reduce((sum, d) => sum + (d.delivery === "inline" ? 10 : 100), 0) }),
      });
      expect(planned.map(p => p.delivery)).toEqual(["inline", "inline"]);
    }
  });

  it("does not use an illegal path for forced-inline inputs during transport replanning", () => {
    const planned = planInputDelivery({
      inputs: [true, false].map((allowMaterialization, i) => ({
        origin: "task_artifact" as const, artifact: makeArtifact({ artifact_id: `art-${i}`, size_bytes: 100 }),
        content_type: "text/plain", inlineCandidate: textOf(100), allowMaterialization,
      })),
      transportEnvelopeLimit: { maxChars: 170 },
      evaluateEnvelope: ds => ({ chars: 50 + ds.reduce((sum, d) => sum + (d.delivery === "inline" ? 100 : 10), 0) }),
    });
    expect(planned.map(p => p.delivery)).toEqual(["read_only_path", "inline"]);
  });

  it("requires UTF-8 byte observations and finite bounds rather than bypassing a cap", () => {
    expect(() => planInputDelivery({ inputs: [], transportEnvelopeLimit: {},
      evaluateEnvelope: () => ({ chars: 10, bytes: 10 }) })).toThrowError(InputPlanError);
    expect(() => planInputDelivery({ inputs: [], transportEnvelopeLimit: { maxBytes: 100 },
      evaluateEnvelope: () => ({ chars: 10 }) })).toThrowError(InputPlanError);
    for (const maxChars of [NaN, Infinity, 0, -1]) {
      expect(() => planInputDelivery({ inputs: [], transportEnvelopeLimit: { maxChars },
        evaluateEnvelope: () => ({ chars: 10 }) })).toThrowError(InputPlanError);
    }
  });

  it("reserves shared inline bytes for a later input that cannot materialize", () => {
    const planned = planInputDelivery({
      inputs: [true, false].map((allowMaterialization, i) => ({
        origin: "task_artifact" as const, artifact: makeArtifact({ artifact_id: `art-${i}`, size_bytes: 9000 }),
        content_type: "text/plain", inlineCandidate: textOf(9000), allowMaterialization,
      })),
      transportEnvelopeLimit: { maxChars: 20000 }, evaluateEnvelope: ds => ({
        chars: ds.reduce((sum, d) => sum + (d.inlineContent?.byteLength ?? 100), 0),
      }),
    });
    expect(planned.map(p => p.delivery)).toEqual(["read_only_path", "inline"]);
  });

  it("can reduce two independently exceeded transport bounds without a false plateau", () => {
    const planned = planInputDelivery({
      inputs: [0, 1].map(i => ({ origin: "task_artifact" as const,
        artifact: makeArtifact({ artifact_id: `art-${i}`, size_bytes: 100 }), content_type: "text/plain",
        inlineCandidate: textOf(100), allowMaterialization: true })),
      transportEnvelopeLimit: { maxChars: 200, maxBytes: 400 },
      evaluateEnvelope: ds => ({
        chars: (ds[0]!.delivery === "inline" ? 200 : 100) + 100,
        bytes: 200 + (ds[1]!.delivery === "inline" ? 400 : 200),
      }),
    });
    expect(planned.every(p => p.delivery === "read_only_path")).toBe(true);
  });
  it("small supported text goes inline with ordered input ids", () => {
    const planned = planInputDelivery({
      inputs: [
        { origin: "task_artifact", artifact: makeArtifact({ size_bytes: 100 }), content_type: "text/plain", inlineCandidate: textOf(100), allowMaterialization: true },
        { origin: "review_diff", artifact: makeArtifact({ artifact_id: "art-2", size_bytes: 50 }), content_type: "text/plain", inlineCandidate: textOf(50), allowMaterialization: true },
      ],
    });
    expect(planned.map((p) => p.input_id)).toEqual(["in-1", "in-2"]);
    expect(planned.every((p) => p.delivery === "inline")).toBe(true);
    expect(planned[0]!.inlineContent?.byteLength).toBe(100);
  });

  it("shared inline budget: overflow goes to read-only materialization", () => {
    const planned = planInputDelivery({
      inputs: [
        { origin: "task_artifact", artifact: makeArtifact({ size_bytes: 8 * 1024 }), content_type: "text/plain", inlineCandidate: textOf(8 * 1024), allowMaterialization: true },
        { origin: "task_artifact", artifact: makeArtifact({ artifact_id: "art-2", size_bytes: 9 * 1024 }), content_type: "text/plain", inlineCandidate: textOf(9 * 1024), allowMaterialization: true },
      ],
    });
    expect(planned[0]!.delivery).toBe("inline");
    expect(planned[1]!.delivery).toBe("read_only_path");
    expect(planned[1]!.inlineContent).toBeNull();
    expect(INLINE_TOTAL_BYTE_CAP).toBe(16 * 1024);
  });

  it("unsupported content type → INPUT_UNSUPPORTED (no channel without a tested profile)", () => {
    expect(() =>
      planInputDelivery({
        inputs: [
          { origin: "task_artifact", artifact: makeArtifact(), content_type: "application/octet-stream", inlineCandidate: textOf(10), allowMaterialization: false },
        ],
      }),
    ).toThrowError(InputPlanError);
    try {
      planInputDelivery({
        inputs: [
          { origin: "task_artifact", artifact: makeArtifact(), content_type: "application/octet-stream", inlineCandidate: textOf(10), allowMaterialization: true },
        ],
      });
      throw new Error("expected InputPlanError");
    } catch (e) {
      expect(e).toBeInstanceOf(InputPlanError);
      expect((e as InputPlanError).code).toBe("INPUT_UNSUPPORTED");
    }
  });

  it("non-sealed artifact → ARTIFACT_NOT_READY", () => {
    try {
      planInputDelivery({
        inputs: [
          { origin: "task_artifact", artifact: makeArtifact({ state: "staging" }), content_type: "text/plain", inlineCandidate: textOf(10), allowMaterialization: true },
        ],
      });
      throw new Error("expected InputPlanError");
    } catch (e) {
      expect(e).toBeInstanceOf(InputPlanError);
      expect((e as InputPlanError).code).toBe("ARTIFACT_NOT_READY");
    }
  });

  it("oversized text without materialization → INPUT_LIMIT", () => {
    try {
      planInputDelivery({
        inputs: [
          { origin: "task_artifact", artifact: makeArtifact({ size_bytes: INLINE_TOTAL_BYTE_CAP + 1 }), content_type: "text/plain", inlineCandidate: textOf(INLINE_TOTAL_BYTE_CAP + 1), allowMaterialization: false },
        ],
      });
      throw new Error("expected InputPlanError");
    } catch (e) {
      expect(e).toBeInstanceOf(InputPlanError);
      expect((e as InputPlanError).code).toBe("INPUT_LIMIT");
    }
  });

  it("replans inline to read_only_path when transport envelope char cap is exceeded", () => {
    // 4000 bytes fits within 16 KiB inline budget, but envelope footprint would exceed 6000 chars
    const candidate = textOf(4000);
    const planned = planInputDelivery({
      inputs: [
        {
          origin: "task_artifact",
          artifact: makeArtifact({ size_bytes: 4000 }),
          content_type: "text/plain",
          inlineCandidate: candidate,
          allowMaterialization: true,
        },
      ],
      transportEnvelopeLimit: { maxChars: 6000 },
      evaluateEnvelope: (deliveries) => {
        const isInline = deliveries[0]?.delivery === "inline";
        // Fixed envelope 2500 chars; if inline +4000 chars = 6500 chars (> 6000); if path +100 chars = 2600 chars (<= 6000)
        return { chars: 2500 + (isInline ? 4000 : 100), bytes: 2500 + (isInline ? 4000 : 100) };
      },
    });
    expect(planned).toHaveLength(1);
    expect(planned[0]!.delivery).toBe("read_only_path");
    expect(planned[0]!.inlineContent).toBeNull();
  });

  it("excessive inline input throws INPUT_LIMIT when materialization is not allowed", () => {
    expect(() =>
      planInputDelivery({
        inputs: [
          {
            origin: "task_artifact",
            artifact: makeArtifact({ size_bytes: 4000 }),
            content_type: "text/plain",
            inlineCandidate: textOf(4000),
            allowMaterialization: false,
          },
        ],
        transportEnvelopeLimit: { maxChars: 6000 },
        evaluateEnvelope: (deliveries) => {
          const isInline = deliveries[0]?.delivery === "inline";
          return { chars: 2500 + (isInline ? 4000 : 100) };
        },
      }),
    ).toThrowError(InputPlanError);
  });

  it("fixed envelope alone exceeding transport limit throws INPUT_LIMIT", () => {
    expect(() =>
      planInputDelivery({
        inputs: [
          {
            origin: "task_artifact",
            artifact: makeArtifact({ size_bytes: 100 }),
            content_type: "text/plain",
            inlineCandidate: textOf(100),
            allowMaterialization: true,
          },
        ],
        transportEnvelopeLimit: { maxChars: 6000 },
        evaluateEnvelope: () => {
          // Even with minimal path delivery, fixed envelope exceeds 6000 chars (e.g. 6200)
          return { chars: 6200 };
        },
      }),
    ).toThrowError(InputPlanError);
  });
});

describe("buildTurnInputManifest (§5.6)", () => {
  const build = (overrideContentHash = false): TurnInputManifest =>
    buildTurnInputManifest({
      turn_id: "turn-1",
      session_id: "session-1",
      policy_profile_id: "pol-writer",
      policy_profile_version: "1",
      workspace_binding: { workspace_id: "ws-main", expected_snapshot_id: "snap-1" },
      planned: [
        { input_id: "in-1", origin: "task_artifact", artifact: makeArtifact(), content_type: "text/plain", delivery: "inline", inlineContent: textOf(10), readOnlyPath: null },
        {
          input_id: "in-2",
          origin: "review_diff",
          artifact: makeArtifact({ artifact_id: "art-2", content_hash: overrideContentHash ? sha256Hex("other") : sha256Hex("content") }),
          content_type: "application/json",
          delivery: "read_only_path",
          inlineContent: null,
          readOnlyPath: "/inputs/turn-1/in-2",
        },
      ],
      now: 42,
    });

  it("binds delivery modes correctly", () => {
    const manifest = build();
    expect(manifest.manifest_version).toBe(1);
    const inline = manifest.inputs[0]!;
    expect(inline.binding).toBe("envelope:input:in-1");
    expect(inline.access_enforcement).toBe("not_applicable");
    const path = manifest.inputs[1]!;
    expect(path.binding).toBe("/inputs/turn-1/in-2");
    expect(path.access_enforcement).toBe("enforced");
    for (const entry of manifest.inputs) expect(entry.lifetime).toBe("turn_until_quiescence");
  });

  it("manifest_hash is stable per content and changes with input content", () => {
    const a = build();
    expect(a.manifest_hash).toMatch(/^[0-9a-f]{64}$/);
    const b = build();
    expect(b.manifest_hash).toBe(a.manifest_hash);
    const c = build(true);
    expect(c.manifest_hash).not.toBe(a.manifest_hash);
  });
});

describe("verifyTurnInputManifest", () => {
  const buildValid = (): TurnInputManifest =>
    buildTurnInputManifest({
      turn_id: "turn-1",
      session_id: "session-1",
      policy_profile_id: "pol-writer",
      policy_profile_version: "1",
      workspace_binding: { review: { baseline_snapshot_id: "snap-b", target_snapshot_id: "snap-t" } },
      planned: [
        { input_id: "in-1", origin: "task_artifact", artifact: makeArtifact(), content_type: "text/plain", delivery: "inline", inlineContent: textOf(10), readOnlyPath: null },
      ],
      now: 1,
    });

  it("a built manifest verifies to no violations", () => {
    expect(verifyTurnInputManifest(buildValid())).toEqual([]);
  });

  it("detects duplicate input ids", () => {
    const m = buildValid();
    m.inputs.push({ ...m.inputs[0]! });
    const errors = verifyTurnInputManifest(m);
    expect(errors.some((e) => e.includes("duplicate input_id"))).toBe(true);
  });

  it("detects inline entry with a non-envelope binding", () => {
    const m = buildValid();
    m.inputs[0]!.binding = "/inputs/turn-1/in-1";
    const errors = verifyTurnInputManifest(m);
    expect(errors.some((e) => e.includes("inline binding"))).toBe(true);
  });

  it("detects path entry with wrong enforcement", () => {
    const m = buildValid();
    m.inputs[0]!.delivery = "read_only_path";
    m.inputs[0]!.binding = "/inputs/turn-1/in-1";
    m.inputs[0]!.access_enforcement = "not_applicable";
    const errors = verifyTurnInputManifest(m);
    expect(errors.some((e) => e.includes("access_enforcement must be enforced"))).toBe(true);
  });

  it("detects manifest_hash tampering", () => {
    const m = buildValid();
    m.manifest_hash = "0".repeat(64);
    const errors = verifyTurnInputManifest(m);
    expect(errors.some((e) => e.includes("manifest_hash mismatch"))).toBe(true);
  });
});
