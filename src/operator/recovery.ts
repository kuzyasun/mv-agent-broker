import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { DatabaseSync, backup } from "node:sqlite";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { acquireStateDirectoryOwnership, type StateDirectoryOwnership } from "../daemon/lifecycle.ts";
import { parseWorktreeJournal, type WorktreeProvisionJournal } from "../workspaces/worktree.ts";
import { resolveSourceCommonDir, pathsEqual, computeManagedWorktreePath } from "../workspaces/worktree.ts";

const MAX_DIAGNOSTIC_ROWS = 100;
const MAX_NOTE_LENGTH = 2_000;
const PROCESS_PROBE_TIMEOUT_MS = 2_000;
const GIT_READ_TIMEOUT_MS = 10_000;
const GIT_OUTPUT_BYTES = 64 * 1024;

export class OperatorRecoveryError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "OperatorRecoveryError";
  }
}

interface WorkspaceRow {
  workspace_id: string;
  project_id: string;
  mode: string;
  canonical_path: string | null;
  quarantined: boolean;
  quarantine_reason: string | null;
}

interface SessionRow {
  session_id: string;
  project_id: string;
  workspace_id: string | null;
  state: string;
  close_state: string;
  close_intent_id: string | null;
  native_conversation_ref: string | null;
  context_status: string;
  block_reason: string | null;
  active_turn_id: string | null;
}

interface IntentRow {
  intent_id: string;
  kind: string;
  session_id: string | null;
  turn_id: string | null;
  state: string;
  payload: string | null;
  created_at: number;
}

interface ReservationRow {
  reservation_id: string;
  kind: string;
  scope: string;
  owner_session_id: string | null;
  owner_turn_id: string | null;
}

interface Candidate {
  workspace: WorkspaceRow;
  sessions: SessionRow[];
  turns: Array<Record<string, unknown>>;
  intents: IntentRow[];
  matchingProvisionIntents: Array<{ intent: IntentRow; journal: WorktreeProvisionJournal }>;
  activeReservations: ReservationRow[];
  nonterminalTurns: Array<Record<string, unknown>>;
  pendingIntents: IntentRow[];
}

interface DiskDisposition {
  allocation_path: string;
  allocation_exists: boolean;
  git_worktree_registered: boolean;
  preserved: true;
}

interface NoDispatchEvidence {
  stage: string;
  native_inference_started: false;
  git_launch_receipt: WorktreeProvisionJournal["launch"];
  recorded_pids: number[];
  process_probe: "not-needed" | "absent";
}

function asWorkspace(row: Record<string, unknown>): WorkspaceRow {
  return {
    workspace_id: String(row.workspace_id),
    project_id: String(row.project_id),
    mode: String(row.mode),
    canonical_path: row.canonical_path === null ? null : String(row.canonical_path),
    quarantined: row.quarantined === 1 || row.quarantined === true,
    quarantine_reason: row.quarantine_reason === null ? null : String(row.quarantine_reason),
  };
}

function asSession(row: Record<string, unknown>): SessionRow {
  return {
    session_id: String(row.session_id),
    project_id: String(row.project_id),
    workspace_id: row.workspace_id === null ? null : String(row.workspace_id),
    state: String(row.state),
    close_state: String(row.close_state),
    close_intent_id: row.close_intent_id === null ? null : String(row.close_intent_id),
    native_conversation_ref: row.native_conversation_ref === null ? null : String(row.native_conversation_ref),
    context_status: String(row.context_status),
    block_reason: row.block_reason === null ? null : String(row.block_reason),
    active_turn_id: row.active_turn_id === null ? null : String(row.active_turn_id),
  };
}

function asIntent(row: Record<string, unknown>): IntentRow {
  return {
    intent_id: String(row.intent_id),
    kind: String(row.kind),
    session_id: row.session_id === null ? null : String(row.session_id),
    turn_id: row.turn_id === null ? null : String(row.turn_id),
    state: String(row.state),
    payload: row.payload === null ? null : String(row.payload),
    created_at: Number(row.created_at),
  };
}

function asReservation(row: Record<string, unknown>): ReservationRow {
  return {
    reservation_id: String(row.reservation_id),
    kind: String(row.kind),
    scope: String(row.scope),
    owner_session_id: row.owner_session_id === null ? null : String(row.owner_session_id),
    owner_turn_id: row.owner_turn_id === null ? null : String(row.owner_turn_id),
  };
}

function parseJournal(intent: IntentRow): WorktreeProvisionJournal | null {
  if (!intent.payload) return null;
  try {
    const parsed: unknown = JSON.parse(intent.payload);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parseWorktreeJournal((parsed as Record<string, unknown>).worktree_provisioning);
  } catch {
    return null;
  }
}

function readCandidate(raw: Pick<DatabaseSync, "prepare">, workspaceId: string): Candidate {
  const workspaceRow = raw.prepare("SELECT * FROM workspaces WHERE workspace_id = ?").get(workspaceId) as Record<string, unknown> | undefined;
  if (!workspaceRow) throw new OperatorRecoveryError(`Workspace '${workspaceId}' does not exist.`);
  const workspace = asWorkspace(workspaceRow);
  const sessions = (raw.prepare("SELECT * FROM sessions WHERE workspace_id = ? ORDER BY created_at LIMIT ?").all(workspaceId, MAX_DIAGNOSTIC_ROWS) as Array<Record<string, unknown>>).map(asSession);
  const sessionIds = sessions.map(session => session.session_id);
  const intents = sessionIds.length === 0
    ? []
    : (raw.prepare(`SELECT * FROM intents WHERE session_id IN (${sessionIds.map(() => "?").join(",")}) ORDER BY created_at LIMIT ?`).all(...sessionIds, MAX_DIAGNOSTIC_ROWS) as Array<Record<string, unknown>>).map(asIntent);
  const matchingProvisionIntents = intents
    .filter(intent => intent.kind === "provision_session")
    .map(intent => ({ intent, journal: parseJournal(intent) }))
    .filter((row): row is { intent: IntentRow; journal: WorktreeProvisionJournal } => row.journal !== null && row.journal.workspace_id === workspaceId);
  const turns = sessionIds.length === 0
    ? []
    : raw.prepare(`SELECT turn_id, session_id, state, execution_started, native_conversation_ref, error_code FROM turns WHERE session_id IN (${sessionIds.map(() => "?").join(",")}) ORDER BY created_at LIMIT ?`).all(...sessionIds, MAX_DIAGNOSTIC_ROWS) as Array<Record<string, unknown>>;
  const activeReservations = raw.prepare("SELECT * FROM reservations WHERE released_at IS NULL AND kind <> 'session_slot' ORDER BY created_at LIMIT ?").all(MAX_DIAGNOSTIC_ROWS) as Array<Record<string, unknown>>;
  const nonterminalTurns = raw.prepare(
    "SELECT turn_id, session_id, state, execution_started, native_conversation_ref FROM turns WHERE state IN ('ACCEPTED','STARTING','RUNNING','CANCELLING','FINALIZING','UNKNOWN') LIMIT ?",
  ).all(MAX_DIAGNOSTIC_ROWS) as Array<Record<string, unknown>>;
  const pendingIntents = (raw.prepare("SELECT * FROM intents WHERE state = 'pending' ORDER BY created_at LIMIT ?").all(MAX_DIAGNOSTIC_ROWS) as Array<Record<string, unknown>>).map(asIntent);
  return {
    workspace,
    sessions,
    turns,
    intents,
    matchingProvisionIntents,
    activeReservations: activeReservations.map(asReservation),
    nonterminalTurns,
    pendingIntents,
  };
}

function scrubGitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^GIT_/i.test(key)) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

function registeredWorktree(sourcePath: string, allocationPath: string): boolean {
  const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: sourcePath,
    encoding: "utf8",
    env: scrubGitEnvironment(),
    windowsHide: true,
    timeout: GIT_READ_TIMEOUT_MS,
    maxBuffer: GIT_OUTPUT_BYTES,
  });
  if (result.error || result.status !== 0 || result.signal) {
    throw new OperatorRecoveryError("Cannot inspect Git worktree registration; refusing reconciliation.");
  }
  return result.stdout
    .split(/\r?\n/)
    .filter(line => line.startsWith("worktree "))
    .some(line => pathsEqual(path.resolve(line.slice("worktree ".length)), allocationPath));
}

function diskDisposition(journal: WorktreeProvisionJournal): DiskDisposition {
  let allocationExists = false;
  try {
    lstatSync(journal.worktree_path);
    allocationExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new OperatorRecoveryError("Cannot verify allocation path absence; refusing reconciliation.");
    }
  }
  if (allocationExists) {
    throw new OperatorRecoveryError("Allocated worktree path exists; preserving it and refusing reconciliation.");
  }
  // The registration check is performed against the registered source path by
  // requireSupportedCandidate, where the source workspace is available.
  return { allocation_path: journal.worktree_path, allocation_exists: false, git_worktree_registered: false, preserved: true };
}

function probeRecordedProcesses(journal: WorktreeProvisionJournal): { available: boolean; alive: number[]; reason?: string } {
  if (!journal.launch) return { available: true, alive: [] };
  if (process.platform !== "win32") return { available: false, alive: [], reason: "Windows process probe is unavailable on this platform." };
  const pids = [journal.launch.root_pid, journal.launch.owner_pid, journal.launch.helper_pid];
  try {
    const filter = [...new Set(pids)].map(pid => `ProcessId = ${pid}`).join(" OR ");
    const output = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `$ErrorActionPreference = 'Stop'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object -ExpandProperty ProcessId)`], {
      encoding: "utf8",
      windowsHide: true,
      timeout: PROCESS_PROBE_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
    });
    const alive: unknown = JSON.parse(output);
    if (!Array.isArray(alive) || !alive.every(pid => Number.isSafeInteger(pid) && pids.includes(pid))) throw new Error("invalid-process-probe");
    return { available: true, alive };
  } catch {
    return { available: false, alive: [], reason: "Windows process probe failed or timed out." };
  }
}

function requireSupportedCandidate(raw: Pick<DatabaseSync, "prepare">, workspaceId: string, stateDir: string): {
  candidate: Candidate;
  journal: WorktreeProvisionJournal;
  session: SessionRow;
  disk: DiskDisposition;
  evidence: NoDispatchEvidence;
} {
  const candidate = readCandidate(raw, workspaceId);
  if (candidate.sessions.length >= MAX_DIAGNOSTIC_ROWS || candidate.intents.length >= MAX_DIAGNOSTIC_ROWS) {
    throw new OperatorRecoveryError("Target history exceeds the inspection bound; refusing incomplete evidence.");
  }
  const { workspace } = candidate;
  if (!workspace.quarantined || workspace.quarantine_reason !== "worktree-provisioning: git-add-failed") {
    throw new OperatorRecoveryError("Only the exact worktree-provisioning: git-add-failed quarantine is supported.");
  }
  if (workspace.mode !== "worktree" || !workspace.canonical_path) {
    throw new OperatorRecoveryError("Workspace is not a broker-allocated worktree with an allocation path.");
  }
  if (candidate.nonterminalTurns.length > 0) {
    throw new OperatorRecoveryError("Nonterminal or UNKNOWN turns exist globally; refusing reconciliation.");
  }
  if (candidate.pendingIntents.length > 0) {
    throw new OperatorRecoveryError("Pending lifecycle intents exist globally; refusing reconciliation.");
  }
  if (raw.prepare("SELECT session_id FROM sessions WHERE active_turn_id IS NOT NULL OR state IN ('ACTIVE','PROVISIONING') OR close_state = 'pending' LIMIT 1").get()) {
    throw new OperatorRecoveryError("An active session or incomplete lifecycle exists globally; refusing reconciliation.");
  }
  if (candidate.activeReservations.length > 0) {
    throw new OperatorRecoveryError("Active execution or workspace reservations exist globally; refusing reconciliation.");
  }
  if (candidate.sessions.length === 0) {
    throw new OperatorRecoveryError("No session is bound to the quarantined workspace.");
  }
  for (const session of candidate.sessions) {
    if (session.state !== "CLOSED" || session.close_state !== "completed" || session.active_turn_id !== null) {
      throw new OperatorRecoveryError("Every session bound to the workspace must be CLOSED with a completed close intent.");
    }
    const closeIntent = session.close_intent_id === null
      ? null
      : candidate.intents.find(intent => intent.intent_id === session.close_intent_id);
    if (!closeIntent || closeIntent.kind !== "close_session" || closeIntent.state !== "completed") {
      throw new OperatorRecoveryError("Every bound session must have a completed close_session intent.");
    }
    if (session.native_conversation_ref !== null || session.context_status !== "not_started") {
      throw new OperatorRecoveryError("A bound session has native context; this workflow never reconciles native history.");
    }
  }
  if (candidate.turns.length > 0) {
    throw new OperatorRecoveryError("A bound session has turn history; this workflow only handles never-dispatched provisioning.");
  }
  if (candidate.matchingProvisionIntents.length !== 1) {
    throw new OperatorRecoveryError("Exactly one matching failed worktree provision intent is required.");
  }
  const { intent, journal } = candidate.matchingProvisionIntents[0]!;
  if (intent.session_id === null || intent.state !== "failed" || candidate.intents.filter(row => row.kind === "provision_session").length !== 1 ||
      journal.workspace_id !== workspaceId || journal.stage !== "adding" ||
      (journal.completion !== undefined && journal.completion !== null)) {
    throw new OperatorRecoveryError("Provision intent is not the exact closed, never-dispatched failed worktree case.");
  }
  const session = candidate.sessions.find(row => row.session_id === intent.session_id);
  if (!session) throw new OperatorRecoveryError("Provision intent session does not match the workspace binding.");
  const sourceRow = raw.prepare("SELECT * FROM workspaces WHERE workspace_id = ?").get(journal.source_workspace_id) as Record<string, unknown> | undefined;
  if (!sourceRow) throw new OperatorRecoveryError("The registered source workspace for the journal is missing.");
  const source = asWorkspace(sourceRow);
  if (source.project_id !== workspace.project_id || source.mode !== "current" || !source.canonical_path) {
    throw new OperatorRecoveryError("The journal source workspace is not a matching registered current checkout.");
  }
  let commonDir: string;
  try {
    commonDir = resolveSourceCommonDir(source.canonical_path);
  } catch {
    throw new OperatorRecoveryError("The registered source checkout cannot be read as a Git repository.");
  }
  if (!pathsEqual(commonDir, journal.source_common_dir)) {
    throw new OperatorRecoveryError("The journal source common directory no longer matches the registered checkout.");
  }
  if (!pathsEqual(workspace.canonical_path, journal.worktree_path)) {
    throw new OperatorRecoveryError("The journal allocation path does not match the workspace row.");
  }
  let expectedAllocation: string;
  try {
    expectedAllocation = computeManagedWorktreePath(path.join(stateDir, "worktrees"), session.session_id);
  } catch {
    throw new OperatorRecoveryError("The broker allocation root cannot be verified.");
  }
  if (!pathsEqual(path.dirname(expectedAllocation), journal.managed_root) || !pathsEqual(expectedAllocation, journal.worktree_path)) {
    throw new OperatorRecoveryError("The journal is not the generated allocation for this session and state directory.");
  }
  const disk = diskDisposition(journal);
  const registered = registeredWorktree(source.canonical_path, journal.worktree_path);
  if (registered) throw new OperatorRecoveryError("The allocation path is registered as a Git worktree; refusing reconciliation.");
  disk.git_worktree_registered = false;
  const processProbe = probeRecordedProcesses(journal);
  if (!processProbe.available) throw new OperatorRecoveryError(processProbe.reason ?? "Process probe unavailable; refusing reconciliation.");
  if (processProbe.alive.length > 0) throw new OperatorRecoveryError("A recorded provisioning process is still present; refusing reconciliation.");
  const evidence: NoDispatchEvidence = {
    stage: journal.stage,
    native_inference_started: false,
    git_launch_receipt: journal.launch,
    recorded_pids: journal.launch ? [journal.launch.root_pid, journal.launch.owner_pid, journal.launch.helper_pid] : [],
    process_probe: journal.launch ? "absent" : "not-needed",
  };
  return { candidate, journal, session, disk, evidence };
}

function receiptPathFor(directory: string): string {
  return path.join(directory, "recovery-receipt.json");
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(temporary, filePath);
}

async function createBackup(db: DatabaseSync, stateDir: string): Promise<{ directory: string; backupPath: string }> {
  const directory = path.join(path.resolve(stateDir), "recovery", `${Date.now()}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const backupPath = path.join(directory, "registry.sqlite");
  try {
    await backup(db, backupPath);
  } catch {
    throw new OperatorRecoveryError("Could not create the private SQLite backup; no registry mutation was attempted.");
  }
  return { directory, backupPath };
}

function summarizeCandidate(candidate: Candidate): Record<string, unknown> {
  return {
    workspace: candidate.workspace,
    sessions: candidate.sessions,
    turns: candidate.turns,
    intents: candidate.intents.map(intent => ({
      intent_id: intent.intent_id,
      kind: intent.kind,
      session_id: intent.session_id,
      turn_id: intent.turn_id,
      state: intent.state,
      created_at: intent.created_at,
      journal: parseJournal(intent) ? {
        workspace_id: parseJournal(intent)!.workspace_id,
        source_workspace_id: parseJournal(intent)!.source_workspace_id,
        source_common_dir: parseJournal(intent)!.source_common_dir,
        worktree_path: parseJournal(intent)!.worktree_path,
        managed_root: parseJournal(intent)!.managed_root,
        stage: parseJournal(intent)!.stage,
        launch_receipt: parseJournal(intent)!.launch,
      } : null,
    })),
    active_reservations: candidate.activeReservations,
    global_nonterminal_turns: candidate.nonterminalTurns,
    global_pending_intents: candidate.pendingIntents.map(intent => ({
      intent_id: intent.intent_id,
      kind: intent.kind,
      session_id: intent.session_id,
      turn_id: intent.turn_id,
      state: intent.state,
    })),
  };
}

export function inspectQuarantine(stateDir: string, workspaceId?: string): Record<string, unknown> {
  const dbPath = path.join(path.resolve(stateDir), "registry.sqlite");
  if (!existsSync(dbPath)) throw new OperatorRecoveryError(`Registry '${dbPath}' does not exist.`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const daemon = db.prepare("SELECT daemon_state, incarnation, started_at, ready_at FROM daemon_state WHERE id = 1").get() as Record<string, unknown> | undefined;
    const ids = workspaceId
      ? [workspaceId]
      : (db.prepare("SELECT workspace_id FROM workspaces WHERE quarantined = 1 ORDER BY workspace_id LIMIT ?").all(MAX_DIAGNOSTIC_ROWS) as Array<{ workspace_id: string }>).map(row => row.workspace_id);
    const workspaces = ids.map(id => {
      try {
        return summarizeCandidate(readCandidate(db, id));
      } catch (error) {
        return { workspace_id: id, error: error instanceof Error ? error.message : String(error) };
      }
    });
    return {
      state_dir: path.resolve(stateDir),
      daemon,
      ready_is_not_admission_proof: true,
      workspace_id: workspaceId ?? null,
      bounded: true,
      workspaces,
    };
  } finally {
    db.close();
  }
}

export async function reconcileWorkspace(args: {
  stateDir: string;
  workspaceId: string;
  note: string;
}): Promise<Record<string, unknown>> {
  if (!args.note.trim() || args.note.length > MAX_NOTE_LENGTH) {
    throw new OperatorRecoveryError(`Operator note must be 1-${MAX_NOTE_LENGTH} characters.`);
  }
  const stateDir = path.resolve(args.stateDir);
  const registryPath = path.join(stateDir, "registry.sqlite");
  if (!existsSync(registryPath)) throw new OperatorRecoveryError(`Registry '${registryPath}' does not exist.`);
  const ownership: StateDirectoryOwnership = await acquireStateDirectoryOwnership(stateDir);
  let db: DatabaseSync | null = null;
  try {
    // Open existing state directly: recovery must never run schema migrations.
    db = new DatabaseSync(registryPath);
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    const initial = requireSupportedCandidate(db, args.workspaceId, stateDir);
    const savedBackup = await createBackup(db, stateDir);
    const receiptPath = receiptPathFor(savedBackup.directory);
    const receipt = {
      workflow: "reconcile-workspace",
      workspace_id: args.workspaceId,
      operator_note: args.note,
      inspected: summarizeCandidate(initial.candidate),
      no_dispatch_evidence: initial.evidence,
      disk_disposition: initial.disk,
      backup_path: savedBackup.backupPath,
      mutation: "pending",
    };
    writeJsonAtomically(receiptPath, receipt);

    const committedAt = Date.now();
    db.exec("BEGIN IMMEDIATE");
    let result: {session_id: string; workspace_id: string};
    try {
      const checked = requireSupportedCandidate(db, args.workspaceId, stateDir);
      const update = db
        .prepare("UPDATE workspaces SET quarantined = 0, quarantine_reason = NULL WHERE workspace_id = ? AND quarantined = 1 AND quarantine_reason = ?")
        .run(args.workspaceId, "worktree-provisioning: git-add-failed");
      if (Number(update.changes) !== 1) throw new OperatorRecoveryError("Workspace quarantine changed during reconciliation; no update committed.");
      const payload = {
        workspace_id: args.workspaceId,
        previous_reason: "worktree-provisioning: git-add-failed",
        note: args.note,
        backup_path: savedBackup.backupPath,
        receipt_path: receiptPath,
        disk_disposition: checked.disk,
        no_dispatch_evidence: checked.evidence,
      };
      db.prepare("INSERT INTO events (turn_id, session_id, type, payload, created_at) VALUES (NULL, ?, ?, ?, ?)")
        .run(checked.session.session_id, "operator_workspace_quarantine_reconciled", JSON.stringify(payload), committedAt);
      result = { session_id: checked.session.session_id, workspace_id: checked.candidate.workspace.workspace_id };
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    writeJsonAtomically(receiptPath, { ...receipt, mutation: "committed", committed_at: committedAt });
    return {
      status: "reconciled",
      workspace_id: result.workspace_id,
      session_id: result.session_id,
      backup_path: savedBackup.backupPath,
      receipt_path: receiptPath,
      disk_disposition: initial.disk,
      no_dispatch_evidence: initial.evidence,
    };
  } finally {
    try { db?.close(); } finally { await ownership.release(); }
  }
}
