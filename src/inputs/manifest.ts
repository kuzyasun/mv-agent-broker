/**
 * TurnInputManifest planning and verification (spec §5.6, §7.1.1, §12.6).
 *
 * The manifest is broker-generated, versioned and immutable after sealing:
 * it records WHAT was delivered, WHERE and UNDER WHICH ENFORCEMENT — never
 * that the model actually read or understood it (§5.6). Delivery selection
 * is deterministic: supported text within the shared inline budget goes
 * inline; everything else is materialized read-only when allowed. Truncation
 * or silent omission of a required input is forbidden (fail explicitly).
 */
import type { ArtifactRecord } from "../shared/api-types.ts";
import { canonicalRequestHash } from "../shared/canonicalize.ts";
import type { TransportEnvelopeLimit } from "../runtime/adapter.ts";

export type InputOrigin = "task_artifact" | "review_baseline" | "review_diff";
export type DeliveryMode = "inline" | "read_only_path";

export const INLINE_TOTAL_BYTE_CAP = 16 * 1024; // §15.1

/**
 * Content types usable for delivery in the default profile. Arbitrary
 * binary formats require an explicitly tested input profile, otherwise
 * INPUT_UNSUPPORTED (§7.1.1).
 */
export const SUPPORTED_INLINE_CONTENT_TYPES = [
  "text/plain",
  "application/json",
  "text/markdown",
  "application/x-snapshot-tree-manifest",
] as const;

export class InputPlanError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "InputPlanError";
  }
}

export interface TurnInputEntry {
  input_id: string;
  origin: InputOrigin;
  artifact_id: string;
  content_hash: string;
  content_type: string;
  size_bytes: number;
  delivery: DeliveryMode;
  /** inline → envelope section id; read_only_path → broker-generated location. */
  binding: string;
  access_enforcement: "enforced" | "not_applicable";
  lifetime: "turn_until_quiescence";
}

export interface TurnInputManifest {
  manifest_version: 1;
  turn_id: string;
  session_id: string;
  policy_binding: { policy_profile_id: string; policy_profile_version: string };
  workspace_binding:
    | { workspace_id: string | null; expected_snapshot_id: string | null }
    | { review: { baseline_snapshot_id: string; target_snapshot_id: string } }
    | { git_review: { workspace_id: string; base_commit: string; target_commit: string; working_tree_digest: string | null } };
  inputs: TurnInputEntry[];
  created_at: number;
  manifest_hash: string;
}

function assertDeliverableArtifact(artifact: ArtifactRecord): void {
  if (artifact.state !== "sealed") {
    throw new InputPlanError(
      `Artifact ${artifact.artifact_id} is ${artifact.state}, not sealed`,
      "ARTIFACT_NOT_READY",
    );
  }
  if (!artifact.content_hash || artifact.size_bytes === null) {
    throw new InputPlanError(
      `Artifact ${artifact.artifact_id} has no content hash/size`,
      "ARTIFACT_NOT_READY",
    );
  }
}

export interface PlannedDelivery {
  input_id: string;
  origin: InputOrigin;
  delivery: DeliveryMode;
  artifact: ArtifactRecord;
  inlineContent: Uint8Array | null;
}

/**
 * Deterministic channel selection (§7.1.1): supported small text inline
 * within the SHARED budget (in request order); the rest read-only
 * materialization when the profile allows it, otherwise INPUT_LIMIT.
 */
export interface PlanInputDeliveryArgs {
  inputs: Array<{
    origin: InputOrigin;
    artifact: ArtifactRecord;
    content_type: string;
    inlineCandidate: Uint8Array | null;
    allowMaterialization: boolean;
  }>;
  transportEnvelopeLimit?: TransportEnvelopeLimit | null;
  evaluateEnvelope?: (
    deliveries: Array<{
      input_id: string;
      delivery: DeliveryMode;
      inlineContent: Uint8Array | null;
    }>,
  ) => { chars: number; bytes?: number };
}

export function planInputDelivery(args: PlanInputDeliveryArgs): PlannedDelivery[] {
  for (const input of args.inputs) {
    assertDeliverableArtifact(input.artifact);
    if (!(SUPPORTED_INLINE_CONTENT_TYPES as readonly string[]).includes(input.content_type)) {
      throw new InputPlanError(
        `Content type '${input.content_type}' has no tested delivery channel (§7.1.1)`,
        "INPUT_UNSUPPORTED",
      );
    }
  }

  const out: PlannedDelivery[] = [];
  let inlineBudgetUsed = 0;

  for (let index = 0; index < args.inputs.length; index++) {
    const input = args.inputs[index]!;
    const candidate = input.inlineCandidate;
    const inputId = `in-${index + 1}`;
    const forcedFutureBytes = args.transportEnvelopeLimit
      ? args.inputs.slice(index + 1).reduce((sum, next) => sum + (!next.allowMaterialization
        ? next.inlineCandidate?.byteLength ?? INLINE_TOTAL_BYTE_CAP + 1 : 0), 0) : 0;

    let fitsInline = false;
    if (candidate && candidate.byteLength <= INLINE_TOTAL_BYTE_CAP - inlineBudgetUsed - forcedFutureBytes) {
      fitsInline = true;
    }

    if (fitsInline && candidate) {
      inlineBudgetUsed += candidate.byteLength;
      out.push({
        input_id: inputId,
        origin: input.origin,
        delivery: "inline",
        artifact: input.artifact,
        inlineContent: candidate,
      });
      continue;
    }

    if (!input.allowMaterialization) {
      throw new InputPlanError(
        `Input ${input.artifact.artifact_id} does not fit the inline budget and materialization is not allowed (§15.1)`,
        "INPUT_LIMIT",
      );
    }

    out.push({
      input_id: inputId,
      origin: input.origin,
      delivery: "read_only_path",
      artifact: input.artifact,
      inlineContent: null,
    });
  }

  const limit = args.transportEnvelopeLimit;
  if (limit) {
    if (!args.evaluateEnvelope || (limit.maxChars === undefined && limit.maxBytes === undefined) ||
        [limit.maxChars, limit.maxBytes].some(n => n !== undefined && (!Number.isFinite(n) || n <= 0))) {
      throw new InputPlanError("Transport bounds require finite positive limits and an envelope evaluator", "INPUT_LIMIT");
    }
    const evaluate = args.evaluateEnvelope;
    const score = (deliveries: PlannedDelivery[]): number => {
      const footprint = evaluate(deliveries);
      if (!Number.isFinite(footprint.chars) || footprint.chars < 0 ||
          (limit.maxBytes !== undefined && (!Number.isFinite(footprint.bytes) || footprint.bytes! < 0))) {
        throw new InputPlanError("Envelope evaluator did not provide valid required measurements", "INPUT_LIMIT");
      }
      return (limit.maxChars === undefined ? 0 : Math.max(0, footprint.chars / limit.maxChars - 1)) +
        (limit.maxBytes === undefined ? 0 : Math.max(0, footprint.bytes! / limit.maxBytes - 1));
    };
    // Evaluate the ACTUAL preferred complete plan first. Short inline values
    // can cost less than path bindings; future inputs cannot be assumed paths.
    // Switch only legal channels that reduce the complete measured footprint.
    let current = score(out);
    while (current > 0) {
      let bestIndex = -1;
      let bestScore = current;
      for (let i = 0; i < out.length; i++) {
        if (out[i]!.delivery !== "inline" || !args.inputs[i]!.allowMaterialization) continue;
        const candidate = out.map((p, index) => index === i
          ? { ...p, delivery: "read_only_path" as const, inlineContent: null } : p);
        const next = score(candidate);
        if (next < bestScore) { bestScore = next; bestIndex = i; }
      }
      if (bestIndex < 0) {
        throw new InputPlanError("Complete envelope exceeds transport limits with available delivery channels", "INPUT_LIMIT");
      }
      out[bestIndex] = { ...out[bestIndex]!, delivery: "read_only_path", inlineContent: null };
      current = bestScore;
    }
  }
  return out;
}

/** Build the immutable manifest; manifest_hash excludes the hash itself. */
export function buildTurnInputManifest(args: {
  turn_id: string;
  session_id: string;
  policy_profile_id: string;
  policy_profile_version: string;
  workspace_binding: TurnInputManifest["workspace_binding"];
  planned: Array<{
    input_id: string;
    origin: InputOrigin;
    artifact: ArtifactRecord;
    content_type: string;
    delivery: DeliveryMode;
    inlineContent: Uint8Array | null;
    readOnlyPath: string | null;
  }>;
  now: number;
}): TurnInputManifest {
  const inputs: TurnInputEntry[] = args.planned.map((p) => {
    if (!p.artifact.content_hash || p.artifact.size_bytes === null) {
      throw new InputPlanError(`Artifact ${p.artifact.artifact_id} is not sealed`, "ARTIFACT_NOT_READY");
    }
    if (p.delivery === "inline") {
      if (!p.inlineContent) {
        throw new InputPlanError(`Inline input ${p.input_id} has no inline bytes`, "INPUT_UNSUPPORTED");
      }
      // §5.6/§7.1.1: inline delivery carries the FULL artifact — a truncated
      // or re-derived candidate is a hard error, never a hidden truncation.
      if (p.inlineContent.byteLength !== p.artifact.size_bytes) {
        throw new InputPlanError(
          `Inline bytes for ${p.input_id} (${p.inlineContent.byteLength}) do not match artifact size (${p.artifact.size_bytes})`,
          "ARTIFACT_CORRUPT",
        );
      }
      return {
        input_id: p.input_id,
        origin: p.origin,
        artifact_id: p.artifact.artifact_id,
        content_hash: p.artifact.content_hash,
        content_type: p.content_type,
        size_bytes: p.artifact.size_bytes,
        delivery: "inline",
        binding: `envelope:input:${p.input_id}`,
        access_enforcement: "not_applicable",
        lifetime: "turn_until_quiescence",
      };
    }
    if (!p.readOnlyPath) {
      throw new InputPlanError(`Materialized input ${p.input_id} has no read-only path`, "INPUT_DELIVERY_FAILED");
    }
    return {
      input_id: p.input_id,
      origin: p.origin,
      artifact_id: p.artifact.artifact_id,
      content_hash: p.artifact.content_hash,
      content_type: p.content_type,
      size_bytes: p.artifact.size_bytes,
      delivery: "read_only_path",
      binding: p.readOnlyPath,
      access_enforcement: "enforced",
      lifetime: "turn_until_quiescence",
    };
  });

  const manifest: TurnInputManifest = {
    manifest_version: 1,
    turn_id: args.turn_id,
    session_id: args.session_id,
    policy_binding: {
      policy_profile_id: args.policy_profile_id,
      policy_profile_version: args.policy_profile_version,
    },
    workspace_binding: args.workspace_binding,
    inputs,
    created_at: args.now,
    manifest_hash: "",
  };
  manifest.manifest_hash = canonicalRequestHash({ ...manifest, manifest_hash: undefined });
  return manifest;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Structural verification per §5.6. Returns every violation found; an empty
 * array means the manifest satisfies the contract surface checked here.
 */
export function verifyTurnInputManifest(manifest: TurnInputManifest): string[] {
  const errors: string[] = [];
  if (manifest.manifest_version !== 1) {
    errors.push(`unsupported manifest_version ${String(manifest.manifest_version)}`);
  }
  const seen = new Set<string>();
  for (const [i, entry] of manifest.inputs.entries()) {
    if (seen.has(entry.input_id)) errors.push(`duplicate input_id ${entry.input_id}`);
    seen.add(entry.input_id);
    if (entry.input_id !== `in-${i + 1}`) errors.push(`input_id ${entry.input_id} out of order at index ${i}`);
    if (!HASH_PATTERN.test(entry.content_hash)) errors.push(`input ${entry.input_id}: bad content_hash`);
    if (!Number.isFinite(entry.size_bytes) || entry.size_bytes < 0) {
      errors.push(`input ${entry.input_id}: bad size_bytes`);
    }
    if (entry.lifetime !== "turn_until_quiescence") {
      errors.push(`input ${entry.input_id}: bad lifetime`);
    }
    if (entry.delivery === "inline") {
      if (!entry.binding.startsWith("envelope:input:")) {
        errors.push(`input ${entry.input_id}: inline binding must be an envelope section id`);
      }
      if (entry.access_enforcement !== "not_applicable") {
        errors.push(`input ${entry.input_id}: inline access_enforcement must be not_applicable`);
      }
    } else {
      if (!entry.binding || entry.binding.startsWith("envelope:input:")) {
        errors.push(`input ${entry.input_id}: read_only_path binding must be a broker location`);
      }
      if (entry.access_enforcement !== "enforced") {
        errors.push(`input ${entry.input_id}: path access_enforcement must be enforced`);
      }
    }
  }
  const inlineTotal = manifest.inputs
    .filter((e) => e.delivery === "inline")
    .reduce((sum, e) => sum + e.size_bytes, 0);
  if (inlineTotal > INLINE_TOTAL_BYTE_CAP) {
    errors.push(`inline inputs exceed the shared byte cap (${inlineTotal} > ${INLINE_TOTAL_BYTE_CAP})`);
  }
  const expected = canonicalRequestHash({ ...manifest, manifest_hash: undefined });
  if (manifest.manifest_hash !== expected) {
    errors.push("manifest_hash mismatch");
  }
  return errors;
}
