#!/usr/bin/env node
/**
 * Cursor reviewer trusted preToolUse permission hook (§13.2, §14.3).
 *
 * Standalone Node script executed by Cursor's preToolUse hook command.
 * Reads bounded stdin bytes, validates the observed native tool_input shapes
 * (Read/Grep/List with file_path fields, per the installed CLI's
 * hooks-carrier createToolInput contracts), enforces canonical workspace/input
 * boundaries captured at policy creation, and appends schema-only audit
 * receipts. All denial messages are fixed strings; no request content is ever
 * echoed back or persisted.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// Bounds are enforced on raw stdin bytes before any decode or parse.
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_POLICY_BYTES = 64 * 1024;
const MAX_AUDIT_LINE_BYTES = 2048;
const MAX_AUDIT_FILE_BYTES = 512 * 1024;
const MAX_PATH_LENGTH = 4096;

// Native hook tool names (hooks-carrier toolName values) and their canonical
// audit labels. Everything else is denied generically as "unknown".
const TOOL_KIND_BY_NAME = Object.freeze({
  Read: "read",
  Grep: "grep",
  List: "ls",
});

// Canonical status enum — only these labels may be persisted in receipts.
const STATUSES = Object.freeze({
  oversizedInput: "oversized_input",
  invalidUtf8: "invalid_utf8",
  emptyInput: "empty_input",
  inputReadFailed: "input_read_failed",
  malformedJson: "malformed_json",
  policyUnreadable: "policy_unreadable",
  invalidPolicy: "invalid_policy",
  toolNotAllowed: "tool_not_allowed",
  unknownInputshape: "unknown_inputshape",
  missingPath: "missing_path",
  invalidPathType: "invalid_path_type",
  pathResolutionFailed: "path_resolution_failed",
  symlinkRejected: "symlink_rejected",
  invalidFileType: "invalid_file_type",
  forbiddenStoreAccess: "forbidden_store_access",
  boundaryViolation: "boundary_violation",
  success: "success",
});

// Fixed denial messages. Category identifies the canonical status; the payload
// content (tool names, paths, model, emails, thinking) is never interpolated.
const DENIAL_MESSAGES = Object.freeze({
  policyUnavailable: "Broker hook policy is unavailable or unsafe; request denied.",
  oversizedInput: "Hook input payload exceeded maximum size.",
  invalidUtf8: "Hook input payload is not valid UTF-8.",
  emptyInput: "Hook input payload was empty.",
  malformedJson: "Hook input payload is malformed JSON.",
  toolNotAllowed: "Requested tool is not allowed in reviewer mode.",
  unknownInputshape: "Requested tool input does not match the allowed native shape.",
  missingPath: "Requested tool requires a target path.",
  invalidPathType: "Requested tool path has an unsupported type.",
  pathResolutionFailed: "Requested path cannot be resolved safely.",
  symlinkRejected: "Requested path is a symbolic link; denied.",
  invalidFileType: "Requested path is not a regular file or directory.",
  forbiddenStoreAccess: "Access to broker private store or state directory is denied.",
  boundaryViolation: "Target path is outside allowed workspace and read-only inputs.",
  internalError: "Broker hook failed; request denied.",
});

function denyAndExit(status, message, exitCode = 0) {
  process.stdout.write(JSON.stringify({
    permission: "deny",
    user_message: message,
  }) + "\n");
  process.exit(exitCode);
}

/**
 * Depth of `candidate` (number of path segments). Used for specificity
 * comparison between canonical grants and canonical exclusions.
 */
function pathDepth(canonicalPath) {
  return path.resolve(canonicalPath).split(path.sep).filter(Boolean).length;
}

/**
 * True when `canonicalPath` equals or is a path-prefix ancestor of
 * `canonicalTarget`. Both inputs must be realpath outputs, so an exact
 * case-sensitive comparison is correct on every platform: realpath returns
 * the filesystem's own casing, and case-sensitive directories yield distinct
 * strings rather than a blanket-lowercase false grant.
 */
function isSubpathOrEqual(canonicalTarget, canonicalPath) {
  if (canonicalTarget === canonicalPath) return true;
  const parent = canonicalPath.endsWith(path.sep) ? canonicalPath : canonicalPath + path.sep;
  return canonicalTarget.startsWith(parent);
}

/**
 * Classify an existing path without following links: "missing", "symlink",
 * "file", "directory", "unsupported" or "error". Every non-file/directory
 * outcome fails closed upstream.
 */
function classifyExisting(candidate) {
  let stat;
  try {
    stat = lstatSync(candidate, { throwIfNoEntry: false });
  } catch {
    return "error";
  }
  if (!stat) return "missing";
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  return "unsupported";
}

function canonicalizeExisting(candidate) {
  const kind = classifyExisting(candidate);
  if (kind !== "file" && kind !== "directory") return null;
  try {
    return { kind, path: path.resolve(realpathSync(candidate)) };
  } catch {
    return null;
  }
}

/**
 * Append a schema-only audit receipt. The audit target must already be an
 * owned regular file (never a symlink, never another file type) or a missing
 * path that appendFileSync can create inside the private config directory.
 * Failures never fabricate proof: the caller's decision stands, the receipt
 * is simply absent.
 */
function writeAuditReceipt(policy, record) {
  const auditLogPath = policy.audit_log_path;
  if (typeof auditLogPath !== "string" || !auditLogPath.trim()) return;
  let lockFd;
  let auditFd;
  const lockPath = auditLogPath + ".lock";
  try {
    // Exclusive creation serializes the size check and append. An existing or
    // uncertain lock means no receipt; it never turns absence into proof.
    lockFd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const stat = lstatSync(auditLogPath, { throwIfNoEntry: false });
    if (stat) {
      if (stat.isSymbolicLink() || !stat.isFile()) return;
    }
    const line = JSON.stringify({
      toolkind: record.toolkind,
      status: record.status,
      decision: record.decision,
      pathhash: record.pathhash,
      callid: record.callid,
      timestamp_ms: Date.now(),
    });
    if (Buffer.byteLength(line, "utf8") > MAX_AUDIT_LINE_BYTES) return;
    auditFd = openSync(auditLogPath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
    const held = fstatSync(auditFd, { bigint: true });
    const current = lstatSync(auditLogPath, { bigint: true });
    if (!held.isFile() || current.isSymbolicLink() || !current.isFile() ||
        held.dev !== current.dev || held.ino !== current.ino) return;
    if (typeof process.getuid === "function" && held.uid !== BigInt(process.getuid())) return;
    const bytes = Buffer.from(line + "\n", "utf8");
    if (held.size + BigInt(bytes.length) > BigInt(MAX_AUDIT_FILE_BYTES)) return;
    // The verified handle remains bound even if the pathname is swapped.
    writeSync(auditFd, bytes);
  } catch {
    // Audit write failures must never fabricate proof or block the decision.
  } finally {
    if (auditFd !== undefined) try { closeSync(auditFd); } catch {}
    if (lockFd !== undefined) {
      try { closeSync(lockFd); } catch {}
      try { unlinkSync(lockPath); } catch {}
    }
  }
}

/**
 * The call id is attacker-influenceable stream content: persist only an
 * opaque bounded hash, never the raw value.
 */
function opaqueCallId(rawCallId) {
  if (typeof rawCallId !== "string" || !rawCallId.trim() || rawCallId.length > 256) return null;
  return createHash("sha256").update(rawCallId, "utf8").digest("hex").slice(0, 32);
}

function sha256PathHash(canonicalPath) {
  return createHash("sha256").update(canonicalPath.slice(0, MAX_PATH_LENGTH), "utf8").digest("hex");
}

function readStdinBounded() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    process.stdin.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_INPUT_BYTES) {
        reject(new Error("oversized"));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks, totalBytes)));
    process.stdin.on("error", () => reject(new Error("stdin_error")));
  });
}

/**
 * Strict native tool_input shapes observed in the installed CLI
 * (hooks-carrier createToolInput). Unknown, path-bearing or flag-bearing
 * extra fields make the whole request fail closed.
 */
function validateToolInput(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) {
    return { ok: false, status: STATUSES.unknownInputshape };
  }
  const keys = Object.keys(toolInput).sort();
  if (toolName === "Read") {
    if (keys.length !== 1 || keys[0] !== "file_path") return { ok: false, status: STATUSES.unknownInputshape };
    if (typeof toolInput.file_path !== "string" || !toolInput.file_path.trim()) {
      return { ok: false, status: STATUSES.missingPath };
    }
    return { ok: true, rawPath: toolInput.file_path, required: true };
  }
  if (toolName === "Grep") {
    const allowed = new Set(["pattern", "file_path", "glob", "output_mode"]);
    for (const key of keys) {
      if (!allowed.has(key)) return { ok: false, status: STATUSES.unknownInputshape };
    }
    if (typeof toolInput.pattern !== "string" || !toolInput.pattern.trim()) {
      return { ok: false, status: STATUSES.unknownInputshape };
    }
    for (const optionalKey of ["file_path", "glob", "output_mode"]) {
      const value = toolInput[optionalKey];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string" || !value.trim()) return { ok: false, status: STATUSES.unknownInputshape };
    }
    return { ok: true, rawPath: typeof toolInput.file_path === "string" ? toolInput.file_path : null, required: false };
  }
  if (toolName === "List") {
    const allowed = new Set(["file_path", "ignore"]);
    for (const key of keys) {
      if (!allowed.has(key)) return { ok: false, status: STATUSES.unknownInputshape };
    }
    const ignore = toolInput.ignore;
    if (ignore !== undefined && ignore !== null) {
      const ignoreOk = Array.isArray(ignore) && ignore.every((item) => typeof item === "string");
      if (!ignoreOk) return { ok: false, status: STATUSES.unknownInputshape };
    }
    const rawPath = toolInput.file_path;
    if (rawPath !== undefined && rawPath !== null) {
      if (typeof rawPath !== "string" || !rawPath.trim()) return { ok: false, status: STATUSES.unknownInputshape };
      return { ok: true, rawPath, required: false };
    }
    return { ok: true, rawPath: null, required: false };
  }
  return { ok: false, status: STATUSES.unknownInputshape };
}

function parseValidRawPath(rawPath) {
  if (typeof rawPath !== "string") return null;
  if (!rawPath.trim() || rawPath.length > MAX_PATH_LENGTH) return null;
  if (rawPath.includes("\0") || rawPath.includes("\r") || rawPath.includes("\n")) return null;
  // Relative paths resolve strictly against the bound workspace; the hook
  // payload's cwd field carries no authority.
  return path.resolve(
    path.isAbsolute(rawPath) ? rawPath : path.join(policyWorkspaceForRelativeResolution, rawPath),
  );
}

let policyWorkspaceForRelativeResolution = ".";

function loadPolicy(policyFile) {
  if (typeof policyFile !== "string" || !policyFile.trim()) {
    denyAndExit(STATUSES.policyUnreadable, DENIAL_MESSAGES.policyUnavailable, 2);
  }
  let stat;
  try {
    stat = lstatSync(policyFile, { throwIfNoEntry: false });
  } catch {
    stat = undefined;
  }
  if (!stat) {
    denyAndExit(STATUSES.policyUnreadable, DENIAL_MESSAGES.policyUnavailable, 2);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    denyAndExit(STATUSES.policyUnreadable, DENIAL_MESSAGES.policyUnavailable, 2);
  }
  if (stat.size > MAX_POLICY_BYTES) {
    denyAndExit(STATUSES.policyUnreadable, DENIAL_MESSAGES.policyUnavailable, 2);
  }

  let policy;
  try {
    const bytes = readFileSync(policyFile);
    const expectedHash = process.argv[3];
    if (bytes.length > MAX_POLICY_BYTES || typeof expectedHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(expectedHash) || createHash("sha256").update(bytes).digest("hex") !== expectedHash) {
      denyAndExit(STATUSES.invalidPolicy, DENIAL_MESSAGES.policyUnavailable, 2);
    }
    policy = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    denyAndExit(STATUSES.invalidPolicy, DENIAL_MESSAGES.policyUnavailable, 2);
  }
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    denyAndExit(STATUSES.invalidPolicy, DENIAL_MESSAGES.policyUnavailable, 2);
  }
  if (policy.version !== 1 || typeof policy.workspace_path !== "string" || !policy.workspace_path.trim()) {
    denyAndExit(STATUSES.invalidPolicy, DENIAL_MESSAGES.policyUnavailable, 2);
  }
  if (!Array.isArray(policy.read_only_input_paths) || !Array.isArray(policy.forbidden_paths)) {
    denyAndExit(STATUSES.invalidPolicy, DENIAL_MESSAGES.policyUnavailable, 2);
  }
  if (!Array.isArray(policy.physical_bindings)) {
    denyAndExit(STATUSES.invalidPolicy, DENIAL_MESSAGES.policyUnavailable, 2);
  }
  const grants = new Set([policy.workspace_path, ...policy.read_only_input_paths]);
  if (policy.physical_bindings.length !== grants.size) {
    denyAndExit(STATUSES.invalidPolicy, DENIAL_MESSAGES.policyUnavailable, 2);
  }
  const verified = new Set();
  for (const binding of policy.physical_bindings) {
    if (!binding || !grants.has(binding.path) || verified.has(binding.path) ||
        !/^[0-9]+$/.test(binding.dev) || !/^[1-9][0-9]*$/.test(binding.ino) ||
        !["file", "directory"].includes(binding.kind)) {
      denyAndExit(STATUSES.invalidPolicy, DENIAL_MESSAGES.policyUnavailable, 2);
    }
    const observed = canonicalizeExisting(binding.path);
    let stat;
    try { stat = statSync(binding.path, { bigint: true }); } catch {}
    if (!observed || observed.path !== binding.path || observed.kind !== binding.kind ||
        !stat || String(stat.dev) !== binding.dev || String(stat.ino) !== binding.ino) {
      denyAndExit(STATUSES.invalidPolicy, DENIAL_MESSAGES.policyUnavailable, 2);
    }
    verified.add(binding.path);
  }
  if (policy.audit_log_path !== undefined && typeof policy.audit_log_path !== "string") {
    denyAndExit(STATUSES.invalidPolicy, DENIAL_MESSAGES.policyUnavailable, 2);
  }

  // The bound workspace must exist as a real directory; without it the hook
  // cannot anchor relative paths or the workspace grant, so fail closed.
  const canonicalWorkspace = canonicalizeExisting(policy.workspace_path);
  if (!canonicalWorkspace || canonicalWorkspace.kind !== "directory") {
    denyAndExit(STATUSES.invalidPolicy, DENIAL_MESSAGES.policyUnavailable, 2);
  }
  if (canonicalWorkspace.path !== policy.workspace_path) {
    denyAndExit(STATUSES.invalidPolicy, DENIAL_MESSAGES.policyUnavailable, 2);
  }
  policyWorkspaceForRelativeResolution = policy.workspace_path;
  return policy;
}

async function main() {
  const policy = loadPolicy(process.argv[2]);

  let rawStdin;
  try {
    rawStdin = await readStdinBounded();
  } catch (error) {
    const oversized = error instanceof Error && error.message === "oversized";
    writeAuditReceipt(policy, {
      toolkind: "unknown",
      status: oversized ? STATUSES.oversizedInput : STATUSES.inputReadFailed,
      decision: "deny",
      pathhash: null,
      callid: null,
    });
    denyAndExit(
      oversized ? STATUSES.oversizedInput : STATUSES.inputReadFailed,
      oversized ? DENIAL_MESSAGES.oversizedInput : DENIAL_MESSAGES.internalError,
      2,
    );
  }

  let payloadText;
  try {
    // Fatal decoding: split or corrupt UTF-8 sequences are rejected outright
    // instead of being silently replaced.
    payloadText = new TextDecoder("utf-8", { fatal: true }).decode(rawStdin);
  } catch {
    writeAuditReceipt(policy, { toolkind: "unknown", status: STATUSES.invalidUtf8, decision: "deny", pathhash: null, callid: null });
    denyAndExit(STATUSES.invalidUtf8, DENIAL_MESSAGES.invalidUtf8, 2);
  }

  const trimmed = payloadText.trim();
  if (!trimmed) {
    writeAuditReceipt(policy, { toolkind: "unknown", status: STATUSES.emptyInput, decision: "deny", pathhash: null, callid: null });
    denyAndExit(STATUSES.emptyInput, DENIAL_MESSAGES.emptyInput, 2);
  }

  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    writeAuditReceipt(policy, { toolkind: "unknown", status: STATUSES.malformedJson, decision: "deny", pathhash: null, callid: null });
    denyAndExit(STATUSES.malformedJson, DENIAL_MESSAGES.malformedJson, 2);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    writeAuditReceipt(policy, { toolkind: "unknown", status: STATUSES.malformedJson, decision: "deny", pathhash: null, callid: null });
    denyAndExit(STATUSES.malformedJson, DENIAL_MESSAGES.malformedJson, 2);
  }

  const callid = opaqueCallId(payload.tool_use_id);
  const auditBase = (toolkind) => ({ toolkind, pathhash: null, callid });

  // Tool allowlist: only the observed native inspect/search tool names.
  const toolkind = Object.prototype.hasOwnProperty.call(TOOL_KIND_BY_NAME, payload.tool_name)
    ? TOOL_KIND_BY_NAME[payload.tool_name]
    : null;
  if (!toolkind) {
    writeAuditReceipt(policy, { ...auditBase("unknown"), status: STATUSES.toolNotAllowed, decision: "deny" });
    denyAndExit(STATUSES.toolNotAllowed, DENIAL_MESSAGES.toolNotAllowed, 0);
  }

  const shape = validateToolInput(payload.tool_name, payload.tool_input);
  if (!shape.ok) {
    writeAuditReceipt(policy, { ...auditBase(toolkind), status: shape.status, decision: "deny" });
    denyAndExit(shape.status, DENIAL_MESSAGES[shape.status] ?? DENIAL_MESSAGES.unknownInputshape, 0);
  }

  if (!shape.required && shape.rawPath === null) {
    // Search/list without an explicit path are anchored to the bound workspace.
    shape.rawPath = policy.workspace_path;
  }

  const resolved = parseValidRawPath(shape.rawPath);
  if (!resolved) {
    const status = shape.required ? STATUSES.missingPath : STATUSES.invalidPathType;
    writeAuditReceipt(policy, { ...auditBase(toolkind), status, decision: "deny" });
    denyAndExit(status, DENIAL_MESSAGES[status], 0);
  }

  const classified = classifyExisting(resolved);
  if (classified !== "file" && classified !== "directory") {
    // Missing, link and special-file targets all fail closed; there is no
    // nearest-existing-ancestor fallback that could grant an unresolved path.
    const status = classified === "symlink" ? STATUSES.symlinkRejected
      : classified === "unsupported" ? STATUSES.invalidFileType
        : STATUSES.pathResolutionFailed;
    writeAuditReceipt(policy, { ...auditBase(toolkind), status, decision: "deny" });
    denyAndExit(status, DENIAL_MESSAGES[status], 0);
  }

  let canonicalTarget;
  try {
    canonicalTarget = path.resolve(realpathSync(resolved));
  } catch {
    writeAuditReceipt(policy, { ...auditBase(toolkind), status: STATUSES.pathResolutionFailed, decision: "deny" });
    denyAndExit(STATUSES.pathResolutionFailed, DENIAL_MESSAGES.pathResolutionFailed, 0);
  }

  // Read is a file reader only; directories fail closed for it.
  if (toolkind === "read" && classified !== "file") {
    writeAuditReceipt(policy, { ...auditBase(toolkind), status: STATUSES.invalidFileType, decision: "deny" });
    denyAndExit(STATUSES.invalidFileType, DENIAL_MESSAGES.invalidFileType, 0);
  }

  const pathhash = sha256PathHash(canonicalTarget);

  // Boundary evaluation over canonical identities captured at policy creation.
  // Deepest match wins: a private exclusion inside the workspace subtree stays
  // denied (workspace-descendant store exclusion), while an explicit grant
  // deeper than a forbidden ancestor stays readable. Ties deny.
  let grantDepth = -1;
  const canonicalWorkspace = path.resolve(policy.workspace_path);
  if (isSubpathOrEqual(canonicalTarget, canonicalWorkspace)) {
    grantDepth = pathDepth(canonicalWorkspace);
  }
  for (const inputPath of policy.read_only_input_paths) {
    if (typeof inputPath !== "string" || !inputPath.trim()) continue;
    const binding = canonicalizeExisting(inputPath);
    if (!binding) continue; // dead or retargeted binding grants nothing
    if (binding.kind === "directory" ? isSubpathOrEqual(canonicalTarget, binding.path)
      : canonicalTarget === binding.path) {
      const depth = pathDepth(binding.path);
      if (depth > grantDepth) grantDepth = depth;
    }
  }

  let forbiddenDepth = -1;
  for (const forbidden of policy.forbidden_paths) {
    if (typeof forbidden !== "string" || !forbidden.trim()) continue;
    if (isSubpathOrEqual(canonicalTarget, path.resolve(forbidden))) {
      const depth = pathDepth(path.resolve(forbidden));
      if (depth > forbiddenDepth) forbiddenDepth = depth;
    }
  }

  if (forbiddenDepth >= 0 && (grantDepth < 0 || forbiddenDepth >= grantDepth)) {
    writeAuditReceipt(policy, { toolkind, status: STATUSES.forbiddenStoreAccess, decision: "deny", pathhash, callid });
    denyAndExit(STATUSES.forbiddenStoreAccess, DENIAL_MESSAGES.forbiddenStoreAccess, 0);
  }

  if (grantDepth < 0) {
    writeAuditReceipt(policy, { toolkind, status: STATUSES.boundaryViolation, decision: "deny", pathhash, callid });
    denyAndExit(STATUSES.boundaryViolation, DENIAL_MESSAGES.boundaryViolation, 0);
  }

  writeAuditReceipt(policy, { toolkind, status: STATUSES.success, decision: "allow", pathhash, callid });
  process.stdout.write(JSON.stringify({ permission: "allow" }) + "\n");
  process.exit(0);
}

main().catch(() => {
  denyAndExit(STATUSES.internalError, DENIAL_MESSAGES.internalError, 2);
});
