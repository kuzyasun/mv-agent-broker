// Opt-in native development through the public MCP interface. No Claude route.
// node --experimental-transform-types scripts/dogfood.mjs <task.json>
// Task: {name, provider, model, effort, write_scope, goal, checks?, review?}.
// review: {provider, model, effort, goal}. Results stay private in .state.
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const repo = fileURLToPath(new URL('../', import.meta.url));
if (process.argv[2] === '--serve') {
  process.stdin.resume();
  process.stdin.on('end', () => process.emit('SIGTERM'));
  await import(pathToFileURL(path.join(process.argv[3], 'src/daemon/main.ts')).href);
} else {
  const task = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  for (const route of [task, task.review].filter(Boolean)) {
    if (!['zcode', 'antigravity', 'cursor', 'mock'].includes(route.provider)) throw new Error('Only authorized providers are allowed.');
    if (typeof route.model !== 'string' || !route.model) throw new Error('Explicit model required.');
  }
  const root = path.join(repo, '.state/dogfood', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`);
  const runtime = path.join(root, 'runtime'); const state = path.join(root, 'state');
  const reviewFrom = task.review_from ? JSON.parse(readFileSync(task.review_from, 'utf8')) : null;
  if (reviewFrom) cpSync(path.join(path.dirname(task.review_from), 'state'), state, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  // Broker runtime comes only from the last accepted Git commit. Writer source
  // stays in the working tree; dirty/untracked implementation cannot enter the
  // daemon that supervises it. Pin once, before copying any files.
  const gitOptions = { cwd: repo, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 16 * 1024 * 1024 };
  const runtimeCommit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${task.runtime_ref ?? 'HEAD'}^{commit}`], gitOptions).toString('utf8').trim();
  const runtimeTree = execFileSync('git', ['ls-tree', '-rz', runtimeCommit, '--', 'src', 'package.json'], gitOptions).toString('utf8');
  let runtimeFiles = 0;
  for (const entry of runtimeTree.split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/s.exec(entry);
    if (!match) throw new Error('Stable runtime requires regular Git-tracked source files.');
    const [, , oid, filename] = match;
    const target = path.resolve(runtime, filename);
    if (!target.startsWith(runtime + path.sep) || (filename !== 'package.json' && !filename.startsWith('src/'))) throw new Error('Invalid stable runtime path.');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, execFileSync('git', ['cat-file', 'blob', oid], gitOptions));
    runtimeFiles++;
  }
  if (!runtimeFiles || !runtimeTree.includes('\tpackage.json\0')) throw new Error('Stable runtime is incomplete.');
  const { openRegistryDb } = await import(pathToFileURL(path.join(runtime, 'src/storage/db.ts')).href);
  const registry = await import(pathToFileURL(path.join(runtime, 'src/storage/repo.ts')).href);
  const { coverageContractHash } = await import(pathToFileURL(path.join(runtime, 'src/workspaces/coverage.ts')).href);
  const db = openRegistryDb(path.join(state, 'registry.sqlite'));
  const coverage = { source_prefixes: ['src', 'tests', 'scripts', 'docs', 'README.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', '.gitignore'], non_source_prefixes: [], excluded_prefixes: ['.git', '.state', 'node_modules', 'dist', 'coverage'] };
  if (!reviewFrom) {
  registry.insertProject(db, { project_id: 'self', display_name: 'Agent Broker self-development', configuration_revision: 1, session_cap: 4, created_at: Date.now() });
  registry.insertCoordinator(db, { coordinator_id: 'self-coordinator', display_name: 'Native MCP development client', allowed_project_ids: ['self'], revoked: false, config_revision: 1 });
  for (const provider of ['zcode', 'antigravity', 'cursor', 'mock']) {
    registry.insertAccount(db, { account_profile_id: provider, provider, quota_scope_id: `native:${provider}`, auth_mode: 'cli-owned' });
  }
  registry.insertCoverageProfile(db, { coverage_profile_id: 'source', version: '1', config: JSON.stringify(coverage), contract_hash: coverageContractHash(coverage) });
  registry.insertPolicyProfile(db, { policy_profile_id: 'worker', version: '1', config: JSON.stringify({ access: 'workspace_write', write_scope: task.write_scope }) });
  registry.insertPolicyProfile(db, { policy_profile_id: 'reviewer', version: '1', config: JSON.stringify({ access: 'read_only', write_scope: [] }) });
  registry.insertWorkspace(db, { workspace_id: 'repo', project_id: 'self', mode: 'current', canonical_path: repo, quarantined: false, quarantine_reason: null, coverage_profile_id: 'source' });
  registry.insertWorkspace(db, { workspace_id: 'review', project_id: 'self', mode: 'review_slot', canonical_path: null, quarantined: false, quarantine_reason: null, coverage_profile_id: 'source' });
  }
  db.close();
  const env = { ...process.env, AB_STATE_DIR: state, AB_COORDINATOR_ID: 'self-coordinator', AB_ROLE: 'daemon',
    AB_ZCODE_BUNDLE: path.join(process.env.LOCALAPPDATA, 'Programs/ZCode/resources/glm/zcode.cjs'),
    AB_ANTIGRAVITY_BIN: path.join(process.env.LOCALAPPDATA, 'agy/bin/agy.exe'),
    AB_CURSOR_BIN: path.join(process.env.LOCALAPPDATA, 'cursor-agent/cursor-agent.ps1') };
  delete env.AB_CLAUDE_BIN; delete env.AB_CODEX_BIN;
  const daemon = spawn(process.execPath, ['--experimental-transform-types', fileURLToPath(import.meta.url), '--serve', runtime], { cwd: runtime, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const daemonClosed = once(daemon, 'close');
  let daemonLog = ''; daemon.stderr.on('data', chunk => { daemonLog += chunk; });
  let bridge; let bridgeClosed; let bridgeLog = ''; let buffer = ''; let nextId = 1;
  const pending = new Map(); const sessions = [];
  const evidence = { name: task.name, runtime, runtimeCommit, runtimeFiles, source: repo, startedAt: new Date().toISOString(), status: 'running', turns: [], routes: [task, task.review].filter(Boolean).map(({ provider, model, effort }) => ({ provider, model, effort })) };
  const save = () => writeFileSync(path.join(root, 'evidence.private.json'), JSON.stringify(evidence, null, 2));
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const tool = async (name, args = {}) => {
    const result = await rpc('tools/call', { name, arguments: args });
    const payload = JSON.parse(result.content[0].text);
    if (result.isError || payload.ok === false) throw new Error(`${name}: ${JSON.stringify(payload)}`);
    return payload;
  };
  const run = async (route, role, binding) => {
    const reviewer = role === 'reviewer';
    const session = await tool('agent_session_spawn', { project_id: 'self', idempotency_key: randomUUID(), provider: route.provider, account_profile_id: route.provider, model: route.model, ...(route.effort == null ? {} : { effort: route.effort }), role,
      instructions: reviewer
        ? 'Independent read-only review. Read the required diff and source in this isolated target snapshot. Do not edit files, run mutating commands, invoke other agents/MCP, commit, or access credentials. Final report MUST fit 3000 characters: findings first, relative path/line, severity and reasoning; say if none found. Omit scope recaps, absolute paths and introductions. Native permission enforcement remains unverified; obey these boundaries.'
        : `Implement the assigned bounded package in the repository. Allowed edits ONLY: ${task.write_scope.join(', ')}. Preserve existing changes. Do not stage/commit/push, delegate, access credentials or call MCP. Read nearby source first. Run requested offline checks, fix failures, and self-review actual diff. Final report MUST fit 3000 characters: changed files, behavior, exact check results and limitations.`,
      workspace: { mode: reviewer ? 'review_slot' : 'current', workspace_id: reviewer ? 'review' : 'repo' }, policy_profile_id: reviewer ? 'reviewer' : 'worker' });
    sessions.push(session.session_id);
    const deadlineMs = route.deadline_ms ?? 900000;
    const accepted = await tool('agent_session_send', { session_id: session.session_id, idempotency_key: randomUUID(), task: { goal: route.goal, checks: route.checks ?? [], artifact_refs: [] }, ...(reviewer ? { review_binding: binding } : { workspace_precondition: { expected_snapshot_id: session.initial_snapshot_id } }), deadline_ms: deadlineMs });
    const record = { role, session, accepted, route: { provider: route.provider, model: route.model, effort: route.effort }, status: null };
    evidence.turns.push(record); save();
    console.log(`START ${role}: ${route.provider} ${route.model} ${route.effort ?? ''}; ${accepted.turn_id}`);
    const until = Date.now() + deadlineMs + 60000; let lastEvent = 0; let lastLog = 0;
    while (true) {
      record.status = await tool('agent_turn_status', { turn_id: accepted.turn_id });
      if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'UNKNOWN', 'ABANDONED'].includes(record.status.state)) break;
      if (Date.now() > until) { await tool('agent_turn_cancel', { turn_id: accepted.turn_id, idempotency_key: randomUUID() }); throw new Error('Development turn timed out; cancellation requested.'); }
      if (Date.now() - lastLog > 15000) {
        const events = await tool('agent_turn_events', { turn_id: accepted.turn_id, after_cursor: lastEvent });
        for (const event of events.events ?? []) {
          lastEvent = Math.max(lastEvent, event.cursor ?? 0);
          // Progress text can contain vendor reasoning; display only tool-call
          // labels and native identity, never arbitrary thought/prose content.
          if (event.type === 'adapter:native_ref_obtained') console.log('NATIVE', event.payload?.ref ?? '');
          if (event.type === 'adapter:progress' && event.payload?.label?.startsWith('tool_call:')) console.log('PROGRESS', event.payload.label);
        }
        console.log('STATE', role, record.status.state); lastLog = Date.now(); save();
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    record.result = await tool('agent_turn_result', { turn_id: accepted.turn_id });
    record.sessionStatus = await tool('agent_session_status', { session_id: session.session_id });
    record.events = await tool('agent_turn_events', { turn_id: accepted.turn_id }); save();
    console.log(`DONE ${role}: ${record.status.state}\n${JSON.stringify(record.result)}`);
    assert.equal(record.status.state, 'SUCCEEDED', 'Native development turn did not succeed; no automatic retry or plan fallback.');
    return { baseline_snapshot_id: session.initial_snapshot_id, target_snapshot_id: record.result.broker_observed.final_snapshot_id };
  };
  try {
    const readyUntil = Date.now() + 20000;
    while (!daemonLog.includes('daemon listening')) {
      if (daemon.exitCode !== null || Date.now() > readyUntil) throw new Error(`Daemon startup failed: ${daemonLog}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    bridge = spawn(process.execPath, ['--experimental-transform-types', 'src/bridge/main-stdio.ts'], { cwd: runtime, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    bridgeClosed = once(bridge, 'close');
    bridge.stderr.on('data', chunk => { bridgeLog += chunk; });
    bridge.stdout.setEncoding('utf8'); bridge.stdout.on('data', chunk => {
      buffer += chunk; let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
        const message = JSON.parse(line); const request = pending.get(message.id);
        if (request) { clearTimeout(request.timer); pending.delete(message.id); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result); }
      }
    });
    bridge.once('close', () => { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(`Bridge closed: ${bridgeLog}`)); } pending.clear(); });
    evidence.initialize = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'broker-dogfood', version: '1' } });
    bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    if (reviewFrom) {
      const worker = reviewFrom.turns.find(turn => turn.role === 'worker');
      if (!worker?.session?.initial_snapshot_id) throw new Error('Review requires a retained worker baseline.');
      if (!['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(worker.status?.state)) throw new Error('Review cannot capture a running or unresolved worker.');
      if (worker.status?.state !== 'SUCCEEDED' && !task.review_current) throw new Error('Review of a failed worker requires an explicit current-source capture.');
      evidence.reviewSource = { turn_id: worker.accepted.turn_id, state: worker.status?.state, capture_current: !!task.review_current };
      let target = worker.result.broker_observed.final_snapshot_id;
      if (task.review_current) {
        // Capture the integrator's fixes using the public interface and mock;
        // review the entire package against the original worker baseline.
        const current = await run({ provider: 'mock', model: 'mock', goal: 'Capture the current integrated source for independent review.', deadline_ms: 60000 }, 'worker');
        target = current.target_snapshot_id;
      }
      if (!target) throw new Error('Review requires a sealed target snapshot.');
      await run(task, 'reviewer', { baseline_snapshot_id: worker.session.initial_snapshot_id, target_snapshot_id: target });
    } else {
      const binding = await run(task, 'worker');
      if (task.review) await run(task.review, 'reviewer', binding);
    }
    evidence.status = 'passed';
  } catch (error) { evidence.status = 'failed'; evidence.error = String(error); process.exitCode = 1; console.error(evidence.error); }
  finally {
    if (bridge && bridge.exitCode === null) {
      for (const session_id of sessions) {
        try { await tool('agent_session_stop', { session_id, idempotency_key: randomUUID() }); } catch (error) { evidence.closeError = String(error); }
      }
      bridge.stdin.end(); await bridgeClosed;
    }
    if (daemon.exitCode === null) daemon.stdin.end();
    await daemonClosed;
    evidence.finishedAt = new Date().toISOString(); save();
    writeFileSync(path.join(root, 'daemon.stderr.private.txt'), daemonLog);
    writeFileSync(path.join(root, 'bridge.stderr.private.txt'), bridgeLog);
    console.log(`EVIDENCE ${root}`);
  }
}
