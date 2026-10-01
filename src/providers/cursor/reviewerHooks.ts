/**
 * Reviewer preToolUse hook configuration and audit log verification for Cursor (§13.2, §14.3).
 *
 * Implements broker-owned trusted preToolUse hooks installed in the private
 * session HOME/.cursor/hooks.json for reviewer turns. Policy paths are frozen
 * to their canonical filesystem identities (realpath) at creation time, the
 * generated hooks.json uses flat native Cursor command entries and is written
 * atomically behind symlink-checked components, and audit logs are read
 * behind byte/event/line caps with strict schema validation.
 */
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BrokerError } from "../../shared/errors.ts";
import { validateCanonicalPath } from "./reviewerProfile.ts";

/**
 * Native hook tool names observed in the installed CLI's hooks-carrier
 * (toolName values) mapped to canonical audit labels. Mirrored by
 * permissionHook.mjs which cannot import TypeScript.
 */
export const HOOK_TOOL_KIND_BY_NAME = Object.freeze({
  Read: "read",
  Grep: "grep",
  List: "ls",
} as const);

export type AllowedHookToolName = keyof typeof HOOK_TOOL_KIND_BY_NAME;

/** Canonical receipt tool kinds persisted by the hook and parser. */
export const ALLOWED_RECEIPT_TOOL_KINDS = Object.freeze([
  "read",
  "grep",
  "glob",
  "ls",
  "shell",
  "mcp",
  "edit",
  "write",
  "delete",
  "task",
  "web_search",
  "web_fetch",
  "unknown",
] as const);

export type AllowedReceiptToolKind = typeof ALLOWED_RECEIPT_TOOL_KINDS[number];

/** Canonical hook receipt status labels; nothing else may be persisted. */
export const REVIEWER_HOOK_STATUSES = Object.freeze([
  "success",
  "oversized_input",
  "invalid_utf8",
  "input_read_failed",
  "empty_input",
  "malformed_json",
  "policy_unreadable",
  "invalid_policy",
  "tool_not_allowed",
  "unknown_inputshape",
  "missing_path",
  "invalid_path_type",
  "path_resolution_failed",
  "symlink_rejected",
  "invalid_file_type",
  "forbidden_store_access",
  "boundary_violation",
  "internal_error",
] as const);

export type ReviewerHookStatus = typeof REVIEWER_HOOK_STATUSES[number];

/**
 * Every tool reaches the trusted gate, including unknown tools. The actual
 * read/search allowlist belongs inside the hook, not in its native matcher.
 */
export const REVIEWER_TOOL_MATCHER = "*";

export interface ReviewerHookPolicy {
  version: 1;
  /** Canonical (realpath) identity of the granted workspace subtree. */
  workspace_path: string;
  /** Canonical identities of exact trusted input bindings. */
  read_only_input_paths: string[];
  /** Canonical identities of always-denied private subtrees. */
  forbidden_paths: string[];
  /** Immutable physical identities; paths alone must never be re-granted. */
  physical_bindings: Array<{ path: string; dev: string; ino: string; kind: "file" | "directory" }>;
  audit_log_path: string;
  session_id?: string;
  turn_id?: string;
}

export interface ReviewerHookAuditRecord {
  toolkind: string;
  status: string;
  decision: "allow" | "deny" | "error" | "unknown";
  pathhash: string | null;
  callid: string | null;
  timestamp_ms: number;
}

/**
 * Native hooks.json uses flat command entries; nested groups belong to the
 * third-party Claude hook importer and are not native Cursor configuration.
 */
export interface ReviewerHookConfig {
  version: 1;
  hooks: {
    preToolUse: Array<{
      matcher: string;
      type: "command";
      command: string;
      failClosed: boolean;
      timeout: number;
    }>;
  };
}

export interface BuildReviewerHookPolicyParams {
  workspace_path: string | null | undefined;
  read_only_input_paths?: readonly string[];
  forbidden_paths?: readonly string[];
  audit_log_path: string;
  session_id?: string;
  turn_id?: string;
}

/** Read bounds for audit logs; all applied before allocation. */
export const MAX_AUDIT_FILE_BYTES = 512 * 1024;
export const MAX_AUDIT_EVENTS = 2000;
export const MAX_AUDIT_LINE_BYTES = 2048;
const MAX_AUDIT_SCAN_LINES = 100_000;

/**
 * Freeze a policy path to its canonical filesystem identity: lexically valid,
 * existing, not a symlink, a regular file or directory, resolved through
 * realpath. Missing or link-bearing paths fail closed at creation.
 */
export function canonicalizeExistingPath(rawPath: unknown, fieldName: string): string {
  const validated = validateCanonicalPath(rawPath, fieldName);
  const stat = lstatSync(validated, { throwIfNoEntry: false });
  if (!stat) {
    throw new BrokerError("POLICY_UNSUPPORTED", `${fieldName} does not exist: ${validated}`, { executionStarted: false });
  }
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new BrokerError("POLICY_UNSUPPORTED", `${fieldName} is a symlink or unsupported file type: ${validated}`, { executionStarted: false });
  }
  try {
    return path.resolve(realpathSync(validated));
  } catch {
    throw new BrokerError("POLICY_UNSUPPORTED", `${fieldName} cannot be resolved to a physical path: ${validated}`, { executionStarted: false });
  }
}

/**
 * Canonicalize an audit log path whose file may not exist yet: the parent
 * directory must be a real directory (resolved through realpath) and the
 * basename rides on that resolved parent. No unresolved-path fallback.
 */
function canonicalizeAuditLogPath(rawPath: string, fieldName: string): string {
  const validated = validateCanonicalPath(rawPath, fieldName);
  const resolved = path.resolve(validated);
  const parent = path.dirname(resolved);
  const parentStat = lstatSync(parent, { throwIfNoEntry: false });
  if (!parentStat || !parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new BrokerError("POLICY_UNSUPPORTED", `${fieldName} parent directory does not exist or contains a link: ${parent}`, { executionStarted: false });
  }
  const realParent = path.resolve(realpathSync(parent));
  const canonical = path.join(realParent, path.basename(resolved));
  const stat = lstatSync(canonical, { throwIfNoEntry: false });
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
    throw new BrokerError("POLICY_UNSUPPORTED", `${fieldName} exists but is a symlink or unsupported file type: ${canonical}`, { executionStarted: false });
  }
  return canonical;
}

export function buildReviewerHookPolicy(params: BuildReviewerHookPolicyParams): ReviewerHookPolicy {
  if (typeof params.workspace_path !== "string" || !params.workspace_path.trim()) {
    throw new BrokerError("POLICY_UNSUPPORTED", "Cursor reviewer requires an explicit workspace_path.", { executionStarted: false });
  }

  const validatedWorkspace = canonicalizeExistingPath(params.workspace_path, "workspace_path");

  const validatedInputs: string[] = [];
  if (params.read_only_input_paths !== null && params.read_only_input_paths !== undefined) {
    if (!Array.isArray(params.read_only_input_paths)) {
      throw new BrokerError("POLICY_UNSUPPORTED", "read_only_input_paths must be an array of paths.", { executionStarted: false });
    }
    for (const item of params.read_only_input_paths) {
      validatedInputs.push(canonicalizeExistingPath(item, "read_only_input_paths"));
    }
  }

  // Forbidden paths are private broker directories controlled by the adapter;
  // they must resolve canonically or the policy is refused (fail closed).
  const validatedForbidden: string[] = [];
  if (params.forbidden_paths !== null && params.forbidden_paths !== undefined) {
    if (!Array.isArray(params.forbidden_paths)) {
      throw new BrokerError("POLICY_UNSUPPORTED", "forbidden_paths must be an array of paths.", { executionStarted: false });
    }
    for (const item of params.forbidden_paths) {
      validatedForbidden.push(canonicalizeExistingPath(item, "forbidden_paths"));
    }
  }

  if (typeof params.audit_log_path !== "string" || !params.audit_log_path.trim()) {
    throw new BrokerError("POLICY_UNSUPPORTED", "audit_log_path must be a non-empty string.", { executionStarted: false });
  }
  const validatedAudit = canonicalizeAuditLogPath(params.audit_log_path, "audit_log_path");
  const physicalBindings = [...new Set([validatedWorkspace, ...validatedInputs])].map((bindingPath) => {
    const stat = statSync(bindingPath, { bigint: true });
    if (stat.ino === 0n) throw new BrokerError("POLICY_UNSUPPORTED", "Physical hook binding identity is unavailable.", { executionStarted: false });
    return { path: bindingPath, dev: String(stat.dev), ino: String(stat.ino), kind: stat.isDirectory() ? "directory" as const : "file" as const };
  });

  return {
    version: 1,
    workspace_path: validatedWorkspace,
    read_only_input_paths: validatedInputs,
    forbidden_paths: validatedForbidden,
    physical_bindings: physicalBindings,
    audit_log_path: validatedAudit,
    session_id: params.session_id,
    turn_id: params.turn_id,
  };
}

function assertSafeCommandPath(p: string, fieldName: string): void {
  if (p.includes("\0") || p.includes("\r") || p.includes("\n")) {
    throw new BrokerError("PROVIDER_INCOMPATIBLE", `${fieldName} contains forbidden newline/null characters.`, { executionStarted: false });
  }
  if (/["'`$;&|%!^<>()]/.test(p)) {
    throw new BrokerError("PROVIDER_INCOMPATIBLE", `${fieldName} contains dangerous shell characters.`, { executionStarted: false });
  }
}

/**
 * Create every component of a private directory without ever traversing a
 * symlink: each level is lstat-checked before descent and re-checked after
 * creation.
 */
function ensurePrivateDirectory(directory: string, fieldName: string): void {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new BrokerError("PROVIDER_INCOMPATIBLE", `${fieldName} component is a link or is not a directory.`, { executionStarted: false });
    }
    if (!stat) {
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new BrokerError("PROVIDER_INCOMPATIBLE", `${fieldName} directory could not be created.`, { executionStarted: false });
        }
      }
    }
    const fresh = lstatSync(current);
    if (!fresh.isDirectory() || fresh.isSymbolicLink()) {
      throw new BrokerError("PROVIDER_INCOMPATIBLE", `${fieldName} component is unsafe after creation.`, { executionStarted: false });
    }
    // The filesystem's own identity for this component must match the path we
    // created (case-insensitively on Windows) — catches link and aliasing
    // tricks where the component resolves somewhere else entirely.
    const observed = path.resolve(realpathSync(current));
    const same = process.platform === "win32"
      ? observed.toLowerCase() === current.toLowerCase()
      : observed === current;
    if (!same) {
      throw new BrokerError("PROVIDER_INCOMPATIBLE", `${fieldName} component resolves outside its expected path.`, { executionStarted: false });
    }
  }
}

/**
 * Atomically replace a regular file: refuses symlink targets, writes a
 * private temp file in the same directory, then renames over the target.
 */
export function atomicWriteFile(filePath: string, contents: string): void {
  const target = path.resolve(filePath);
  const dir = path.dirname(target);
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new BrokerError("PROVIDER_INCOMPATIBLE", "Refusing to write through a symlink or non-file config target.", { executionStarted: false });
  }
  const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, contents, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, target);
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // rename already moved it
    }
  }
}

export function writeReviewerHooksConfig(params: {
  homeDir: string;
  policyPath: string;
  nodeBinary?: string;
  timeoutSeconds?: number;
}): { hooksConfigPath: string; command: string } {
  const homeDir = path.resolve(params.homeDir);
  const dotCursor = path.join(homeDir, ".cursor");
  ensurePrivateDirectory(dotCursor, ".cursor");

  const nodeBinary = path.resolve(params.nodeBinary ?? process.execPath);
  const scriptPath = path.resolve(fileURLToPath(new URL("./permissionHook.mjs", import.meta.url)));
  const policyPath = path.resolve(params.policyPath);

  assertSafeCommandPath(nodeBinary, "nodeBinary");
  assertSafeCommandPath(scriptPath, "permissionHookScript");
  assertSafeCommandPath(policyPath, "policyPath");

  const policyStat = lstatSync(policyPath);
  if (policyStat.isSymbolicLink() || !policyStat.isFile() || policyStat.size > 64 * 1024) {
    throw new BrokerError("PROVIDER_INCOMPATIBLE", "Hook policy is unsafe or oversized.", { executionStarted: false });
  }
  const policyHash = createHash("sha256").update(readFileSync(policyPath)).digest("hex");
  const command = `"${nodeBinary}" "${scriptPath}" "${policyPath}" "${policyHash}"`;

  const config: ReviewerHookConfig = {
    version: 1,
    hooks: {
      preToolUse: [
        {
          matcher: REVIEWER_TOOL_MATCHER,
          type: "command",
          command,
          failClosed: true,
          timeout: params.timeoutSeconds ?? 30,
        },
      ],
    },
  };

  const hooksConfigPath = path.join(dotCursor, "hooks.json");
  atomicWriteFile(hooksConfigPath, JSON.stringify(config, null, 2));

  return { hooksConfigPath, command };
}

export function validateAuditRecord(raw: unknown): ReviewerHookAuditRecord | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;

  if (
    typeof obj.toolkind !== "string" ||
    !(ALLOWED_RECEIPT_TOOL_KINDS as readonly string[]).includes(obj.toolkind)
  ) {
    return null;
  }
  if (
    typeof obj.status !== "string" ||
    !(REVIEWER_HOOK_STATUSES as readonly string[]).includes(obj.status)
  ) {
    return null;
  }
  if (obj.decision !== "allow" && obj.decision !== "deny" && obj.decision !== "error" && obj.decision !== "unknown") {
    return null;
  }
  let pathhash: string | null = null;
  if (obj.pathhash !== null && obj.pathhash !== undefined) {
    if (typeof obj.pathhash !== "string" || !/^[0-9a-f]{64}$/.test(obj.pathhash)) {
      return null;
    }
    pathhash = obj.pathhash;
  }
  let callid: string | null = null;
  if (obj.callid !== null && obj.callid !== undefined) {
    // Persisted call ids are opaque bounded hashes produced by the hook.
    if (typeof obj.callid !== "string" || !/^[0-9a-f]{32}$/.test(obj.callid)) {
      return null;
    }
    callid = obj.callid;
  }
  if (typeof obj.timestamp_ms !== "number" || !Number.isFinite(obj.timestamp_ms) || obj.timestamp_ms < 0) {
    return null;
  }

  return {
    toolkind: obj.toolkind,
    status: obj.status,
    decision: obj.decision,
    pathhash,
    callid,
    timestamp_ms: obj.timestamp_ms,
  };
}

/**
 * Read a bounded slice of the audit log: refuses symlinks and non-files,
 * reads at most MAX_AUDIT_FILE_BYTES from the tail of larger files, skips
 * oversized or malformed lines, and returns at most MAX_AUDIT_EVENTS valid
 * records. A missing log is an empty result, never fabricated proof.
 */
export function readAuditLog(auditLogPath: string): ReviewerHookAuditRecord[] {
  const stat = lstatSync(auditLogPath, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.isSymbolicLink() || !stat.isFile()) return [];

  let content: string;
  try {
    const size = statSync(auditLogPath).size;
    if (size <= MAX_AUDIT_FILE_BYTES) {
      content = readFileSync(auditLogPath, "utf8");
    } else {
      // Bounded tail read: only the most recent events matter.
      const handle = openSync(auditLogPath, "r");
      try {
        const buffer = Buffer.allocUnsafe(MAX_AUDIT_FILE_BYTES);
        const bytesRead = readSync(handle, buffer, 0, MAX_AUDIT_FILE_BYTES, size - MAX_AUDIT_FILE_BYTES);
        content = buffer.toString("utf8", 0, bytesRead);
      } finally {
        closeSync(handle);
      }
    }
  } catch {
    return [];
  }

  const records: ReviewerHookAuditRecord[] = [];
  let cursor = 0;
  let scanned = 0;
  while (cursor < content.length && scanned < MAX_AUDIT_SCAN_LINES) {
    scanned += 1;
    let newline = content.indexOf("\n", cursor);
    const end = newline === -1 ? content.length : newline;
    const line = content.slice(cursor, end).trim();
    cursor = newline === -1 ? content.length : newline + 1;
    if (!line || line.length > MAX_AUDIT_LINE_BYTES) continue;
    try {
      const validated = validateAuditRecord(JSON.parse(line));
      if (validated) {
        records.push(validated);
        if (records.length > MAX_AUDIT_EVENTS) {
          records.shift();
        }
      }
    } catch {
      // Discard malformed lines
    }
  }
  return records;
}
