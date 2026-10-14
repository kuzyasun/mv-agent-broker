/** Read-only, optional observations of the agy 1.3 conversation store. */
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

const MAX_STEPS = 10_000;
const MAX_STEP_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AntigravityConversationCheckpoint {
  conversationId: string;
  lastIndex: number;
  errors: readonly string[];
}

export interface AntigravityNativeTurnEvidence {
  userIndex: number;
  lastIndex: number;
  errors: readonly string[];
  response: string | null;
  completedResponse: boolean;
}

interface WireField { field: number; bytes?: Uint8Array }

// Only the observed length-delimited fields are read. Unknown fields are skipped;
// malformed/changed records make the observation unavailable, never successful.
function wireFields(input: Uint8Array): WireField[] {
  let offset = 0;
  const out: WireField[] = [];
  const varint = (): bigint => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= input.length) throw new Error("Truncated protobuf varint");
      const byte = input[offset++]!;
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw new Error("Invalid protobuf varint");
  };
  while (offset < input.length) {
    const tag = Number(varint());
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 0) throw new Error("Invalid protobuf field");
    if (wire === 0) { varint(); out.push({ field }); }
    else if (wire === 2) {
      const length = Number(varint());
      if (!Number.isSafeInteger(length) || length < 0 || offset + length > input.length) throw new Error("Invalid protobuf length");
      out.push({ field, bytes: input.subarray(offset, offset + length) });
      offset += length;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > input.length) throw new Error("Truncated protobuf field");
    } else throw new Error("Unsupported protobuf wire type");
  }
  return out;
}

const nested = (bytes: Uint8Array, field: number): Uint8Array | undefined =>
  wireFields(bytes).find(f => f.field === field)?.bytes;
const decodeText = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

function errorText(payload: Uint8Array): string {
  // Observed Cortex error step: step.error(24).error(3).message(2).
  const error = nested(payload, 24);
  const detail = error && nested(error, 3);
  const text = detail && nested(detail, 2);
  if (!text) throw new Error("Unrecognized Antigravity error step");
  return decodeText(text);
}

function responseText(payload: Uint8Array): string | null {
  // Observed agent_response step: step.agent_response(20).response(1).
  const response = nested(payload, 20);
  const text = response && nested(response, 1);
  return text ? decodeText(text) : null;
}

function readConversation<T>(conversationId: string, directory: string | undefined, read: (db: DatabaseSync) => T): T | null {
  if (!UUID.test(conversationId)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path.join(directory ?? path.join(os.homedir(), ".gemini", "antigravity-cli", "conversations"), `${conversationId}.db`), { readOnly: true });
    db.exec("BEGIN");
    const meta = db.prepare("SELECT cascade_id FROM trajectory_meta LIMIT 1").get() as { cascade_id: string } | undefined;
    if (meta?.cascade_id !== conversationId) return null;
    return read(db);
  } catch {
    // Optional native observations are not launch or workspace authorization gates.
    return null;
  } finally {
    db?.close();
  }
}

export function captureAntigravityConversation(conversationId: string, directory?: string): AntigravityConversationCheckpoint | null {
  return readConversation(conversationId, directory, db => {
    const last = db.prepare("SELECT max(idx) AS idx FROM steps").get() as { idx: number | null };
    const rows = db.prepare("SELECT CASE WHEN length(step_payload)<=? THEN step_payload END AS step_payload FROM steps WHERE step_type=17 ORDER BY idx DESC LIMIT 257").all(MAX_STEP_BYTES) as { step_payload: Uint8Array | null }[];
    if (rows.length > 256) throw new Error("Too many native errors");
    const errors = rows.map(row => {
      if (!row.step_payload) throw new Error("Oversized native error step");
      return errorText(row.step_payload);
    });
    return { conversationId, lastIndex: last.idx ?? -1, errors };
  });
}

export function readAntigravityTurnEvidence(conversationId: string, checkpoint: AntigravityConversationCheckpoint | null, directory?: string): AntigravityNativeTurnEvidence | null {
  if (checkpoint && checkpoint.conversationId !== conversationId) return null;
  return readConversation(conversationId, directory, db => {
    const size = db.prepare("SELECT sum(length(step_payload)) AS bytes FROM steps WHERE idx>?").get(checkpoint?.lastIndex ?? -1) as { bytes: number | null };
    if ((size.bytes ?? 0) > MAX_STEP_BYTES) throw new Error("Oversized native turn");
    const rows = db.prepare("SELECT idx,step_type,status,step_payload FROM steps WHERE idx>? ORDER BY idx LIMIT ?").all(checkpoint?.lastIndex ?? -1, MAX_STEPS + 1) as {
      idx: number; step_type: number; status: number; step_payload: Uint8Array;
    }[];
    if (rows.length === 0 || rows.length > MAX_STEPS) throw new Error("Native turn unavailable");
    if (rows.some(row => !row.step_payload || row.step_payload.length > MAX_STEP_BYTES)) throw new Error("Invalid native step");
    const users = rows.filter(row => row.step_type === 14);
    if (users.length !== 1 || users[0]!.idx !== rows[0]!.idx) throw new Error("Ambiguous native turn boundary");
    const last = rows.at(-1)!;
    return {
      userIndex: users[0]!.idx,
      lastIndex: last.idx,
      errors: rows.filter(row => row.step_type === 17).map(row => errorText(row.step_payload)),
      response: last.step_type === 15 ? responseText(last.step_payload) : null,
      completedResponse: last.step_type === 15 && last.status === 3 && rows.every(row => row.status === 3),
    };
  });
}
