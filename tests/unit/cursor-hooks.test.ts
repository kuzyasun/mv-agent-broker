/**
 * Unit tests for Cursor trusted preToolUse reviewer hooks (§13.2, §14.3).
 *
 * Exercises the real generated hook script and command against the actual
 * shared broker state layout: reviewer slots (state/slots) and bound inputs
 * (state/inputs) stay readable while blobs, private session homes (including
 * other turns), the per-turn config/audit directory, and unbound paths fail
 * closed. Also covers byte-bounded stdin, strict native tool_input shapes,
 * canonical audit labels, symlink hardening, and per-turn grant refresh.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  buildReviewerHookPolicy,
  readAuditLog,
  REVIEWER_HOOK_STATUSES,
  validateAuditRecord,
  writeReviewerHooksConfig,
} from "../../src/providers/cursor/reviewerHooks.ts";

const tempRoots: string[] = [];

// File symlinks on Windows require privilege (admin or developer mode).
// Probe once so link-dependent tests can be skipped honestly instead of
// crashing on EPERM; junctions (directory links) always work.
const canCreateFileSymlinks = (() => {
  const probeDir = mkdtempSync(path.join(os.tmpdir(), "broker-symlink-probe-"));
  const target = path.join(probeDir, "target.txt");
  const link = path.join(probeDir, "link.txt");
  try {
    writeFileSync(target, "probe", "utf8");
    symlinkSync(target, link, "file");
    return true;
  } catch {
    return false;
  } finally {
    try { rmSync(probeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
})();

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

const hookScriptPath = fileURLToPath(new URL("../../src/providers/cursor/permissionHook.mjs", import.meta.url));

/**
 * Shared broker state layout: workspace = state/slots/<slot>, inputs =
 * state/inputs, private blobs and per-session homes under state, and a
 * per-turn private config directory holding the policy and the audit log.
 */
function createTestEnv() {
  const root = mkdtempSync(path.join(os.tmpdir(), "broker-cursor-hooks-test-"));
  tempRoots.push(root);

  const stateDir = path.join(root, "state");
  const workspace = path.join(stateDir, "slots", "slot-A");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(path.join(workspace, "index.ts"), "console.log('workspace file');");
  mkdirSync(path.join(workspace, "src"), { recursive: true });
  writeFileSync(path.join(workspace, "src", "nested.ts"), "export const x = 1;");

  const inputsDir = path.join(stateDir, "inputs");
  mkdirSync(inputsDir, { recursive: true });
  const inputFile = path.join(inputsDir, "doc.md");
  writeFileSync(inputFile, "read-only input");
  const subInputDir = path.join(inputsDir, "sub");
  mkdirSync(subInputDir, { recursive: true });
  writeFileSync(path.join(subInputDir, "subfile.txt"), "sub input content");

  const blobsDir = path.join(stateDir, "blobs");
  mkdirSync(blobsDir, { recursive: true });
  writeFileSync(path.join(blobsDir, "blob.bin"), "sealed blob");

  const homeDir = path.join(stateDir, "sessions", "sesshash1", "home");
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(path.join(homeDir, "native-history.json"), "private native history");
  const otherHomeDir = path.join(stateDir, "sessions", "sesshash2", "home");
  mkdirSync(otherHomeDir, { recursive: true });
  writeFileSync(path.join(otherHomeDir, "other-turn.json"), "other turn history");

  const outsideDir = path.join(root, "outside");
  mkdirSync(outsideDir, { recursive: true });
  const outsideFile = path.join(outsideDir, "secret.txt");
  writeFileSync(outsideFile, "super-secret");

  const configDir = path.join(root, "config");
  mkdirSync(configDir, { recursive: true });
  const auditLogPath = path.join(configDir, "reviewer-audit.jsonl");

  const policy = buildReviewerHookPolicy({
    workspace_path: workspace,
    read_only_input_paths: [inputFile, subInputDir],
    forbidden_paths: [path.join(stateDir, "sessions"), configDir],
    audit_log_path: auditLogPath,
    session_id: "test-sess",
    turn_id: "test-turn-1",
  });

  const policyPath = path.join(configDir, "reviewer-policy.json");
  writeFileSync(policyPath, JSON.stringify(policy, null, 2), "utf8");

  return {
    root,
    stateDir,
    workspace,
    outsideDir,
    outsideFile,
    homeDir,
    otherHomeDir,
    blobsDir,
    configDir,
    inputFile,
    inputsDir,
    subInputDir,
    auditLogPath,
    policy,
    policyPath,
  };
}

function invokeHook(policyPath: string, inputPayload: unknown, opts: { rawInput?: string | Buffer; timeout?: number; policyHash?: string } = {}) {
  const stdinStr = opts.rawInput !== undefined ? opts.rawInput : JSON.stringify(inputPayload);
  const policyHash = opts.policyHash ?? createHash("sha256").update(existsSync(policyPath) ? readFileSync(policyPath) : Buffer.alloc(0)).digest("hex");
  const res = spawnSync(process.execPath, [hookScriptPath, policyPath, policyHash], {
    input: stdinStr,
    encoding: "utf8",
    windowsHide: true,
    timeout: opts.timeout ?? 15000,
  });

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(res.stdout.trim());
  } catch {
    // Malformed stdout
  }

  return {
    exitCode: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    parsed,
  };
}

function readPayload(toolName: string, toolInput: unknown, toolUseId?: string) {
  return { tool_name: toolName, tool_input: toolInput, ...(toolUseId ? { tool_use_id: toolUseId } : {}) };
}

describe("Cursor Reviewer trusted preToolUse hook", () => {
  it("rejects policy bytes replaced after the native command was created", () => {
    const env = createTestEnv();
    const originalHash = createHash("sha256").update(readFileSync(env.policyPath)).digest("hex");
    const expanded = buildReviewerHookPolicy({ workspace_path: env.outsideDir, read_only_input_paths: [], forbidden_paths: [], audit_log_path: env.auditLogPath });
    writeFileSync(env.policyPath, JSON.stringify(expanded));
    const response = invokeHook(env.policyPath, readPayload("Read", { file_path: env.outsideFile }), { policyHash: originalHash });
    expect(response.exitCode).toBe(2);
    expect(response.parsed?.permission).toBe("deny");
  });
  it("does not grant a replacement input at the same canonical filename", () => {
    const env = createTestEnv();
    expect(invokeHook(env.policyPath, readPayload("Read", { file_path: env.inputFile })).parsed?.permission).toBe("allow");
    const original = readFileSync(env.inputFile);
    renameSync(env.inputFile, env.inputFile + ".retained");
    writeFileSync(env.inputFile, original);
    const response = invokeHook(env.policyPath, readPayload("Read", { file_path: env.inputFile }));
    expect(response.exitCode).toBe(2);
    expect(response.parsed?.permission).toBe("deny");
  });

  it("does not expand the workspace grant through a retargeted ancestor junction", () => {
    const env = createTestEnv();
    const slots = path.dirname(env.workspace);
    renameSync(slots, slots + "-retained");
    const foreignSlots = path.join(env.root, "foreign-slots");
    const foreignWorkspace = path.join(foreignSlots, path.basename(env.workspace));
    mkdirSync(foreignWorkspace, { recursive: true });
    writeFileSync(path.join(foreignWorkspace, "index.ts"), "harmless outside marker");
    symlinkSync(foreignSlots, slots, process.platform === "win32" ? "junction" : "dir");
    const response = invokeHook(env.policyPath, readPayload("Read", { file_path: path.join(env.workspace, "index.ts") }));
    expect(response.exitCode).toBe(2);
    expect(response.parsed?.permission).toBe("deny");
  });

  it("does not keep growing a saturated private audit log", () => {
    const env = createTestEnv();
    writeFileSync(env.auditLogPath, "x".repeat(512 * 1024));
    const response = invokeHook(env.policyPath, readPayload("Read", { file_path: "index.ts" }));
    expect(response.parsed?.permission).toBe("allow");
    expect(readFileSync(env.auditLogPath).byteLength).toBe(512 * 1024);
  });

  it("keeps the audit byte cap under concurrent native hook invocations", async () => {
    const env = createTestEnv();
    const cap = 512 * 1024;
    writeFileSync(env.auditLogPath, "x".repeat(cap - 500));
    const hash = createHash("sha256").update(readFileSync(env.policyPath)).digest("hex");
    await Promise.all(Array.from({ length: 12 }, (_, index) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [hookScriptPath, env.policyPath, hash], { windowsHide: true, timeout: 15000 });
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => { output += chunk; });
      child.on("error", reject);
      child.on("close", code => {
        try {
          expect(code).toBe(0);
          expect(JSON.parse(output).permission).toBe("allow");
          resolve();
        } catch (error) { reject(error); }
      });
      child.stdin.end(JSON.stringify(readPayload("Read", { file_path: "index.ts" }, `concurrent-${index}`)));
    })));
    expect(readFileSync(env.auditLogPath).byteLength).toBeLessThanOrEqual(cap);
  });

  it("shared-state grants: slots workspace and bound inputs readable", () => {
    const env = createTestEnv();

    // Workspace file, absolute and relative (resolved against the bound
    // workspace; the payload cwd carries no authority).
    const resWorkspace = invokeHook(env.policyPath, readPayload("Read", { file_path: path.join(env.workspace, "index.ts") }, "call-ws"));
    expect(resWorkspace.exitCode).toBe(0);
    expect(resWorkspace.parsed).toEqual({ permission: "allow" });

    const resRel = invokeHook(env.policyPath, { ...readPayload("Read", { file_path: "src/nested.ts" }, "call-rel"), cwd: "C:\\completely\\unrelated\\cwd" });
    expect(resRel.exitCode).toBe(0);
    expect(resRel.parsed).toEqual({ permission: "allow" });

    // Exact input binding and a bound input directory descendant.
    const resInput = invokeHook(env.policyPath, readPayload("Read", { file_path: env.inputFile }, "call-inp"));
    expect(resInput.exitCode).toBe(0);
    expect(resInput.parsed).toEqual({ permission: "allow" });

    const resSubInput = invokeHook(env.policyPath, readPayload("Read", { file_path: path.join(env.subInputDir, "subfile.txt") }, "call-sub"));
    expect(resSubInput.exitCode).toBe(0);
    expect(resSubInput.parsed).toEqual({ permission: "allow" });

    // Search and list: default path is the bound workspace; observed native
    // optional fields (glob/output_mode/ignore) stay allowed.
    const resGrepDefault = invokeHook(env.policyPath, readPayload("Grep", { pattern: "console" }, "call-grep"));
    expect(resGrepDefault.exitCode).toBe(0);
    expect(resGrepDefault.parsed).toEqual({ permission: "allow" });

    const resGrepFields = invokeHook(env.policyPath, readPayload("Grep", { pattern: "x", file_path: path.join(env.workspace, "src"), glob: "*.ts", output_mode: "content" }, "call-grep2"));
    expect(resGrepFields.parsed).toEqual({ permission: "allow" });

    const resList = invokeHook(env.policyPath, readPayload("List", { file_path: env.workspace, ignore: ["node_modules"] }, "call-ls"));
    expect(resList.exitCode).toBe(0);
    expect(resList.parsed).toEqual({ permission: "allow" });

    const resListInput = invokeHook(env.policyPath, readPayload("List", { file_path: env.subInputDir }, "call-ls2"));
    expect(resListInput.parsed).toEqual({ permission: "allow" });
  });

  it("shared-state denials: blobs, private homes (other turns), config/audit, unbound paths", () => {
    const env = createTestEnv();

    const expectDeny = (res: ReturnType<typeof invokeHook>) => expect(res.parsed?.permission).toBe("deny");

    // Blobs and both session homes (own and other turn) are never granted.
    expectDeny(invokeHook(env.policyPath, readPayload("Read", { file_path: path.join(env.blobsDir, "blob.bin") }, "call-blob")));
    expectDeny(invokeHook(env.policyPath, readPayload("Read", { file_path: path.join(env.homeDir, "native-history.json") }, "call-home")));
    expectDeny(invokeHook(env.policyPath, readPayload("Read", { file_path: path.join(env.otherHomeDir, "other-turn.json") }, "call-otherhome")));

    // The per-turn config directory (policy + audit log) is forbidden.
    expectDeny(invokeHook(env.policyPath, readPayload("Read", { file_path: env.auditLogPath }, "call-audit")));
    expectDeny(invokeHook(env.policyPath, readPayload("Read", { file_path: env.policyPath }, "call-policy")));

    // Outside the state layout entirely.
    expectDeny(invokeHook(env.policyPath, readPayload("Read", { file_path: env.outsideFile }, "call-outside")));

    // Another file in the state root but outside grants.
    const stray = path.join(env.stateDir, "stray.txt");
    writeFileSync(stray, "stray");
    expectDeny(invokeHook(env.policyPath, readPayload("Read", { file_path: stray }, "call-stray")));

    // Exact-binding directory isolation: siblings of an exact input file
    // stay denied.
    const otherInInputs = path.join(env.inputsDir, "other-unbound.txt");
    writeFileSync(otherInInputs, "unbound");
    expectDeny(invokeHook(env.policyPath, readPayload("Read", { file_path: otherInInputs }, "call-other-in-dir")));
  });

  it("workspace-descendant store exclusion stays denied over the workspace grant", () => {
    const env = createTestEnv();
    const storeDir = path.join(env.workspace, ".broker-store");
    mkdirSync(storeDir, { recursive: true });
    const storeFile = path.join(storeDir, "state.db");
    writeFileSync(storeFile, "store");

    // The exclusion is deeper than the workspace grant: it must win.
    const policy = buildReviewerHookPolicy({
      workspace_path: env.workspace,
      read_only_input_paths: [],
      forbidden_paths: [storeDir, path.join(env.stateDir, "sessions"), env.configDir],
      audit_log_path: env.auditLogPath,
      turn_id: "turn-excl",
    });
    const policyPath = path.join(env.configDir, "policy-excl.json");
    writeFileSync(policyPath, JSON.stringify(policy, null, 2), "utf8");

    expect(invokeHook(policyPath, readPayload("Read", { file_path: storeFile }, "call-store")).parsed?.permission).toBe("deny");
    // Regular workspace files stay readable under the same policy.
    expect(invokeHook(policyPath, readPayload("Read", { file_path: path.join(env.workspace, "index.ts") }, "call-ws")).parsed?.permission).toBe("allow");
  });

  it("strict native shapes: wrong field names, unknown flags and traversal fail closed", () => {
    const env = createTestEnv();

    // Read takes file_path only: a path-bearing `path` key is not native.
    expect(invokeHook(env.policyPath, readPayload("Read", { path: path.join(env.workspace, "index.ts") })).parsed?.permission).toBe("deny");

    // Unknown / flag-bearing fields (follow, subagent, flags) are rejected.
    expect(invokeHook(env.policyPath, readPayload("Grep", { pattern: "x", file_path: env.workspace, follow: true })).parsed?.permission).toBe("deny");
    expect(invokeHook(env.policyPath, readPayload("Grep", { pattern: "x", file_path: env.workspace, flags: "-r" })).parsed?.permission).toBe("deny");
    expect(invokeHook(env.policyPath, readPayload("List", { file_path: env.workspace, subagent: "x" })).parsed?.permission).toBe("deny");

    // Empty pattern is not a valid native shape.
    expect(invokeHook(env.policyPath, readPayload("Grep", { pattern: "" })).parsed?.permission).toBe("deny");

    // Traversal and symlink escapes from the bound workspace.
    expect(invokeHook(env.policyPath, readPayload("Grep", { pattern: "x", file_path: "../../outside" })).parsed?.permission).toBe("deny");

    const linkPath = path.join(env.workspace, "escaped-link");
    symlinkSync(env.outsideDir, linkPath, (process.platform === "win32" ? "junction" : "dir"));
    expect(invokeHook(env.policyPath, readPayload("Read", { file_path: path.join(linkPath, "secret.txt") })).parsed?.permission).toBe("deny");

    // Missing target fails closed (no nearest-ancestor unresolved grant).
    expect(invokeHook(env.policyPath, readPayload("Read", { file_path: path.join(env.workspace, "does-not-exist.txt") })).parsed?.permission).toBe("deny");

    // Read is a file reader only.
    expect(invokeHook(env.policyPath, readPayload("Read", { file_path: env.workspace })).parsed?.permission).toBe("deny");
  });

  it("all mutators and unknown tools are denied generically", () => {
    const env = createTestEnv();

    for (const tool of ["Write", "Edit", "Delete"]) {
      const res = invokeHook(env.policyPath, readPayload(tool, { file_path: path.join(env.workspace, "index.ts") }));
      expect(res.parsed?.permission).toBe("deny");
    }

    for (const tool of ["Shell", "Bash", "WebFetch", "WebSearch", "Task", "Subagent", "mcp__server__tool"]) {
      const res = invokeHook(env.policyPath, readPayload(tool, { command: "echo bad" }));
      expect(res.parsed?.permission).toBe("deny");
    }

    const resUnknown = invokeHook(env.policyPath, readPayload("CustomSuperTool", {}));
    expect(resUnknown.parsed?.permission).toBe("deny");

    // Unknown input shapes for allowed tools.
    expect(invokeHook(env.policyPath, readPayload("Read", {})).parsed?.permission).toBe("deny");
    expect(invokeHook(env.policyPath, readPayload("Read", "just a string")).parsed?.permission).toBe("deny");
  });

  it("byte-bounded stdin with fatal UTF-8 decode and no newline bypass", () => {
    const env = createTestEnv();

    // Invalid UTF-8 bytes are rejected outright.
    const resInvalidUtf8 = invokeHook(env.policyPath, null, { rawInput: Buffer.from([0x7b, 0xff, 0xfe, 0x7d]) });
    expect(resInvalidUtf8.exitCode).toBe(2);
    expect(resInvalidUtf8.parsed?.permission).toBe("deny");

    // A multibyte payload over the byte bound but far under the old JS-char
    // bound is rejected: the limit counts actual UTF-8 bytes.
    const multibyte = "é".repeat(150_000); // 300000 bytes, 150000 chars
    expect(Buffer.byteLength(multibyte, "utf8")).toBeGreaterThan(256 * 1024);
    const resOversized = invokeHook(env.policyPath, null, { rawInput: multibyte });
    expect(resOversized.exitCode).toBe(2);
    expect(resOversized.parsed?.permission).toBe("deny");

    // A raw newline inside a JSON string is invalid JSON, not a bypass.
    const resRawNewline = invokeHook(env.policyPath, null, { rawInput: '{"tool_name":"Read","tool_input":{"file_path":"a\nb"}}' });
    expect(resRawNewline.exitCode).toBe(2);
    expect(resRawNewline.parsed?.permission).toBe("deny");

    // Empty and malformed payloads fail closed.
    const resEmpty = invokeHook(env.policyPath, null, { rawInput: "   \n" });
    expect(resEmpty.exitCode).toBe(2);
    const resMalformed = invokeHook(env.policyPath, null, { rawInput: "{ not valid json" });
    expect(resMalformed.exitCode).toBe(2);
    expect(resMalformed.parsed?.permission).toBe("deny");
  });

  it("audit receipts use canonical labels and opaque hashed call ids only", () => {
    const env = createTestEnv();

    const cotToolName = "ChainOfThoughtLeak-internal-reasoning-9f2a";
    invokeHook(env.policyPath, readPayload("Read", { file_path: path.join(env.workspace, "index.ts") }, "call-audit-allow"));
    invokeHook(env.policyPath, readPayload("Write", { file_path: path.join(env.workspace, "index.ts") }, "call-audit-deny"));
    invokeHook(env.policyPath, readPayload(cotToolName, {}, "call-audit-cot"));

    const records = readAuditLog(env.auditLogPath);
    expect(records.length).toBe(3);

    const allowRec = records.find(r => r.status === "success");
    expect(allowRec).toBeDefined();
    expect(allowRec!.toolkind).toBe("read");
    expect(allowRec!.decision).toBe("allow");
    expect(allowRec!.pathhash).toHaveLength(64);
    expect(allowRec!.callid).toMatch(/^[0-9a-f]{32}$/);

    const denyRec = records.find(r => r.status === "tool_not_allowed");
    expect(denyRec).toBeDefined();
    expect(denyRec!.toolkind).toBe("unknown");
    expect(denyRec!.decision).toBe("deny");
    expect(denyRec!.callid).toMatch(/^[0-9a-f]{32}$/);

    // The raw tool name (including chain-of-thought-style content) and the
    // raw call ids are nowhere in the audit log or the hook output.
    const auditRaw = readFileSync(env.auditLogPath, "utf8");
    expect(auditRaw).not.toContain(cotToolName);
    expect(auditRaw).not.toContain("call-audit-allow");
    expect(auditRaw).not.toContain("call-audit-deny");
    expect(auditRaw).not.toContain(env.workspace.toLowerCase());

    // Every persisted status is a canonical enum label.
    for (const record of records) {
      expect(REVIEWER_HOOK_STATUSES).toContain(record.status);
    }

    // Denial messages are fixed generic strings; no tool names or paths.
    const denied = invokeHook(env.policyPath, readPayload("Write", { file_path: path.join(env.workspace, "index.ts") }, "call-generic"));
    expect(denied.parsed?.user_message).toBe("Requested tool is not allowed in reviewer mode.");
    const boundary = invokeHook(env.policyPath, readPayload("Read", { file_path: env.outsideFile }, "call-boundary"));
    expect(boundary.parsed?.user_message).toBe("Target path is outside allowed workspace and read-only inputs.");
  });

  it("audit reader enforces schema, caps and link rejection", () => {
    const env = createTestEnv();

    // Schema validation rejects malformed records and non-canonical labels.
    expect(validateAuditRecord(null)).toBeNull();
    expect(validateAuditRecord({})).toBeNull();
    expect(validateAuditRecord({ toolkind: "Read", status: "ok", decision: "invalid-decision" })).toBeNull();
    expect(validateAuditRecord({ toolkind: "CustomCoT", status: "success", decision: "allow", timestamp_ms: 1 })).toBeNull();
    expect(validateAuditRecord({ toolkind: "read", status: "made_up_status", decision: "allow", timestamp_ms: 1 })).toBeNull();
    expect(validateAuditRecord({ toolkind: "read", status: "success", decision: "allow", callid: "call-raw", timestamp_ms: 1 })).toBeNull();
    expect(validateAuditRecord({ toolkind: "read", status: "success", decision: "allow", timestamp_ms: -1 })).toBeNull();

    // Event cap: valid records beyond MAX_AUDIT_EVENTS are trimmed to the
    // most recent window.
    const cappedPath = path.join(env.configDir, "capped-audit.jsonl");
    const validLine = JSON.stringify({ toolkind: "read", status: "success", decision: "allow", pathhash: null, callid: null, timestamp_ms: 1 });
    writeFileSync(cappedPath, Array.from({ length: 2500 }, () => validLine).join("\n") + "\n", "utf8");
    const capped = readAuditLog(cappedPath);
    expect(capped.length).toBe(2000);

    // Oversized and malformed lines are skipped, not loaded.
    const mixedPath = path.join(env.configDir, "mixed-audit.jsonl");
    writeFileSync(mixedPath, `${validLine}\n${"x".repeat(5000)}\nnot json\n${validLine.replace("read", "CoTTool")}\n`, "utf8");
    expect(readAuditLog(mixedPath).length).toBe(1);

    // Symlinked audit logs return no fabricated records.
    if (canCreateFileSymlinks) {
      const validRecord = { toolkind: "read", status: "success", decision: "allow", pathhash: null, callid: null, timestamp_ms: 1 };
      const target = path.join(env.configDir, "target.jsonl");
      writeFileSync(target, JSON.stringify(validRecord) + "\n", "utf8");
      const link = path.join(env.configDir, "link.jsonl");
      symlinkSync(target, link, "file");
      expect(readAuditLog(link)).toEqual([]);
    }
  });

  it.runIf(canCreateFileSymlinks)("symlink hardening: policy link, audit link and hooks.json link all fail closed", () => {
    const env = createTestEnv();

    // Policy file reached through a symlink is refused (exit 2, deny).
    const realPolicy = path.join(env.configDir, "real-policy.json");
    writeFileSync(realPolicy, JSON.stringify(env.policy, null, 2), "utf8");
    const policyLink = path.join(env.configDir, "policy-link.json");
    symlinkSync(realPolicy, policyLink, "file");
    const resLink = invokeHook(policyLink, readPayload("Read", { file_path: path.join(env.workspace, "index.ts") }));
    expect(resLink.exitCode).toBe(2);
    expect(resLink.parsed?.permission).toBe("deny");

    // buildReviewerHookPolicy refuses an audit path that already is a link.
    const auditTarget = path.join(env.configDir, "audit-target.jsonl");
    writeFileSync(auditTarget, "seed\n", "utf8");
    const auditLink = path.join(env.configDir, "audit-link.jsonl");
    symlinkSync(auditTarget, auditLink, "file");
    expect(() => buildReviewerHookPolicy({
      workspace_path: env.workspace,
      read_only_input_paths: [],
      forbidden_paths: [],
      audit_log_path: auditLink,
    })).toThrow();

    // A hand-written policy pointing the audit log at a symlink must not
    // write through the link: the decision stands, the target stays intact.
    const rawPolicy = { ...env.policy, audit_log_path: auditLink };
    const rawPolicyPath = path.join(env.configDir, "raw-policy.json");
    writeFileSync(rawPolicyPath, JSON.stringify(rawPolicy, null, 2), "utf8");
    const before = readFileSync(auditTarget, "utf8");
    const resAuditLink = invokeHook(rawPolicyPath, readPayload("Read", { file_path: path.join(env.workspace, "index.ts") }));
    expect(resAuditLink.parsed).toEqual({ permission: "allow" });
    expect(readFileSync(auditTarget, "utf8")).toBe(before);

    // hooks.json reached through a symlink is refused and left untouched.
    const homeDir = path.join(env.root, "hook-home");
    mkdirSync(path.join(homeDir, ".cursor"), { recursive: true });
    const victim = path.join(homeDir, "victim.json");
    writeFileSync(victim, "do not touch", "utf8");
    const hooksLink = path.join(homeDir, ".cursor", "hooks.json");
    symlinkSync(victim, hooksLink, "file");
    expect(() => writeReviewerHooksConfig({ homeDir, policyPath: env.policyPath })).toThrow();
    expect(readFileSync(victim, "utf8")).toBe("do not touch");

    // A symlinked .cursor component is refused outright.
    const linkedHome = path.join(env.root, "hook-home-2");
    mkdirSync(linkedHome, { recursive: true });
    symlinkSync(path.join(env.root, "elsewhere"), path.join(linkedHome, ".cursor"), (process.platform === "win32" ? "junction" : "dir"));
    expect(() => writeReviewerHooksConfig({ homeDir: linkedHome, policyPath: env.policyPath })).toThrow();
  });

  it.runIf(canCreateFileSymlinks)("grant retargeting is denied: bindings swapped for links grant nothing", () => {
    const env = createTestEnv();

    const resBefore = invokeHook(env.policyPath, readPayload("Read", { file_path: env.inputFile }, "call-before"));
    expect(resBefore.parsed).toEqual({ permission: "allow" });

    // Retarget the exact input binding through a symlink to outside data.
    rmSync(env.inputFile);
    symlinkSync(env.outsideFile, env.inputFile, "file");

    const resRetargeted = invokeHook(env.policyPath, readPayload("Read", { file_path: env.inputFile }, "call-retarget"));
    expect(resRetargeted.parsed?.permission).toBe("deny");

    // A workspace subdirectory retargeted via junction is likewise denied.
    const nestedLink = path.join(env.workspace, "src-link");
    symlinkSync(env.outsideDir, nestedLink, (process.platform === "win32" ? "junction" : "dir"));
    expect(invokeHook(env.policyPath, readPayload("Read", { file_path: path.join(nestedLink, "secret.txt") })).parsed?.permission).toBe("deny");
  });

  it("missing or malformed policy files fail closed with exit 2", () => {
    const env = createTestEnv();

    const resMissing = invokeHook(path.join(env.configDir, "nonexistent-policy.json"), readPayload("Read", { file_path: "index.ts" }));
    expect(resMissing.exitCode).toBe(2);
    expect(resMissing.parsed?.permission).toBe("deny");

    const malformedPath = path.join(env.configDir, "malformed-policy.json");
    writeFileSync(malformedPath, "{ not json", "utf8");
    const resMalformed = invokeHook(malformedPath, readPayload("Read", { file_path: "index.ts" }));
    expect(resMalformed.exitCode).toBe(2);
    expect(resMalformed.parsed?.permission).toBe("deny");

    const schemalessPath = path.join(env.configDir, "schemaless-policy.json");
    writeFileSync(schemalessPath, JSON.stringify({ version: 1 }), "utf8");
    const resSchemaless = invokeHook(schemalessPath, readPayload("Read", { file_path: "index.ts" }));
    expect(resSchemaless.exitCode).toBe(2);
    expect(resSchemaless.parsed?.permission).toBe("deny");
  });

  it("generated hooks config uses the native schema and really executes end to end", () => {
    const env = createTestEnv();
    const homeDir = path.join(env.root, "reviewer-home");
    mkdirSync(homeDir, { recursive: true });

    const { hooksConfigPath, command } = writeReviewerHooksConfig({ homeDir, policyPath: env.policyPath });
    expect(existsSync(hooksConfigPath)).toBe(true);
    const parsedConfig = JSON.parse(readFileSync(hooksConfigPath, "utf8"));
    expect(parsedConfig.version).toBe(1);
    expect(parsedConfig.hooks.preToolUse).toHaveLength(1);
    const nativeCommand = parsedConfig.hooks.preToolUse[0];
    expect(nativeCommand.matcher).toBe("*");
    expect(nativeCommand.type).toBe("command");
    expect(nativeCommand.command).toBe(command);
    expect(nativeCommand.failClosed).toBe(true);
    expect(nativeCommand.timeout).toBe(30);
    expect(nativeCommand.hooks).toBeUndefined();

    // Reconstruct for a second turn: the regenerated command is invoked
    // directly (not merely asserted as config), proving quoting and paths.
    const { command: commandTurn2 } = writeReviewerHooksConfig({ homeDir, policyPath: env.policyPath });
    expect(commandTurn2).toBe(command);

    const resAllow = spawnSync(command, {
      input: JSON.stringify(readPayload("Read", { file_path: path.join(env.workspace, "index.ts") }, "call-e2e-allow")),
      encoding: "utf8",
      shell: process.platform === "win32",
      windowsHide: true,
    });
    expect(JSON.parse(resAllow.stdout.trim())).toEqual({ permission: "allow" });

    const resDeny = spawnSync(command, {
      input: JSON.stringify(readPayload("Read", { file_path: path.join(env.homeDir, "native-history.json") }, "call-e2e-deny")),
      encoding: "utf8",
      shell: process.platform === "win32",
      windowsHide: true,
    });
    expect(JSON.parse(resDeny.stdout.trim()).permission).toBe("deny");
    expect(resDeny.stdout).not.toContain(env.homeDir);

    // The installed CLI selects flat command records and applies the matcher
    // before invoking them. Every native tool must reach our own deny gate.
    for (const toolName of ["Shell", "Write", "MCP:example", "Task", "UnknownTool"]) {
      const selected = parsedConfig.hooks.preToolUse.filter((entry: {command?: string; matcher?: string}) =>
        typeof entry.command === "string" && (!entry.matcher || entry.matcher === "*" || new RegExp(entry.matcher).test(toolName)));
      expect(selected).toHaveLength(1);
      const denied = spawnSync(selected[0].command, {
        input: JSON.stringify(readPayload(toolName, {})), encoding: "utf8",
        shell: process.platform === "win32", windowsHide: true,
      });
      expect(JSON.parse(denied.stdout.trim()).permission).toBe("deny");
    }
  });

  it("repeated turns: new inputs allowed, old inputs denied, same audit stream", () => {
    const env = createTestEnv();

    const inputA = path.join(env.root, "inputA.txt");
    const inputB = path.join(env.root, "inputB.txt");
    writeFileSync(inputA, "content A");
    writeFileSync(inputB, "content B");

    const policyTurn1 = buildReviewerHookPolicy({
      workspace_path: env.workspace,
      read_only_input_paths: [inputA],
      forbidden_paths: [path.join(env.stateDir, "sessions"), env.configDir],
      audit_log_path: env.auditLogPath,
      turn_id: "turn-1",
    });
    const policyPath1 = path.join(env.configDir, "policy-turn1.json");
    writeFileSync(policyPath1, JSON.stringify(policyTurn1, null, 2), "utf8");

    expect(invokeHook(policyPath1, readPayload("Read", { file_path: inputA })).parsed?.permission).toBe("allow");
    expect(invokeHook(policyPath1, readPayload("Read", { file_path: inputB })).parsed?.permission).toBe("deny");

    const policyTurn2 = buildReviewerHookPolicy({
      workspace_path: env.workspace,
      read_only_input_paths: [inputB],
      forbidden_paths: [path.join(env.stateDir, "sessions"), env.configDir],
      audit_log_path: env.auditLogPath,
      turn_id: "turn-2",
    });
    const policyPath2 = path.join(env.configDir, "policy-turn2.json");
    writeFileSync(policyPath2, JSON.stringify(policyTurn2, null, 2), "utf8");

    expect(invokeHook(policyPath2, readPayload("Read", { file_path: inputA })).parsed?.permission).toBe("deny");
    expect(invokeHook(policyPath2, readPayload("Read", { file_path: inputB })).parsed?.permission).toBe("allow");

    const records = readAuditLog(env.auditLogPath);
    expect(records.length).toBe(4);
    expect(records.every(r => (REVIEWER_HOOK_STATUSES as readonly string[]).includes(r.status))).toBe(true);
  });

  it("worker turns have no generated hook config", () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), "worker-home-"));
    tempRoots.push(homeDir);
    expect(existsSync(path.join(homeDir, ".cursor", "hooks.json"))).toBe(false);
  });
});
