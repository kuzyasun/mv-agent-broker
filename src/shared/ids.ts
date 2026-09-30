import { createHash, randomBytes } from "node:crypto";

/** Opaque, prefixed IDs. Prefixes carry kind only, never semantics. */
export function newId(prefix: string): string {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export const ID_PREFIX = {
  session: "session",
  turn: "turn",
  artifact: "art",
  snapshot: "snap",
  event: "ev",
  incarnation: "inc",
  intent: "intent",
  reservation: "res",
  workspace: "ws",
  project: "project",
  coordinator: "coord",
  account: "acct",
  policy: "pol",
  runtime: "rt",
} as const;
