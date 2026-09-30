// Opt-in: exactly two native turns via an external stdio MCP client and daemon.
// node --experimental-transform-types tests/native-smoke/codex-mcp.mjs <native codex executable> <model> <effort>
// --mock rehearses the same transport/lifecycle without native inference.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const repo = fileURLToPath(new URL('../../', import.meta.url));
if (process.argv[2] === '--instrument-daemon') {
  const root = process.argv[3]; const records = []; const original = childProcess.spawn;
  const save = () => writeFileSync(path.join(root, 'native-processes.private.json'), JSON.stringify(records, null, 2));
  childProcess.spawn = function (binary, args, options) {
    const child = original(binary, args, options);
    if (binary !== process.env.AB_CODEX_BIN) return child;
    const record = { binary, args, cwd: options?.cwd, pid: child.pid, startedAt: new Date().toISOString(), exitCode: null, stdout: '', stderr: '', stdin: '' };
    records.push(record);
    const end = child.stdin.end;
    child.stdin.end = function (...args) {
      if (typeof args[0] === 'string' || Buffer.isBuffer(args[0])) record.stdin = args[0].toString();
      save(); return end.apply(this, args);
    };
    child.stdout.on('data', chunk => { record.stdout += chunk; });
    child.stderr.on('data', chunk => { record.stderr += chunk; });
    child.on('close', code => { record.exitCode = code; record.finishedAt = new Date().toISOString(); save(); });
    return child;
  };
  syncBuiltinESMExports();
  process.stdin.resume();
  process.stdin.on('end', () => process.emit('SIGTERM'));
  await import('../../src/daemon/main.ts');
} else {
  const mock = process.argv[2] === '--mock';
  const binary = mock ? null : process.argv[2]; const model = mock ? 'mock-model' : process.argv[3];
  const effort = mock ? 'low' : process.argv[4];
  if (!model || !effort || (!mock && !path.isAbsolute(binary))) throw new Error('Explicit absolute executable, model and effort required.');
  const root = path.resolve(repo, '.state/native-smoke', new Date().toISOString().replace(/[:.]/g, '-') + '-codex-mcp');
  const stateDir = path.join(root, 'broker'); const workspace = path.join(root, 'workspace');
  mkdirSync(path.join(workspace, 'src'), { recursive: true });
  writeFileSync(path.join(workspace, 'src/fixture.txt'), 'Native continuity smoke; do not modify.\n');
  // Git init creates a disposable repository, never a commit in the real project.
  const git = childProcess.spawnSync('git', ['init', '--quiet', workspace], { encoding: 'utf8', windowsHide: true });
  assert.equal(git.status, 0, git.stderr);
  const { openRegistryDb } = await import('../../src/storage/db.ts');
  const { insertProject, insertCoordinator, insertAccount, insertCoverageProfile, insertPolicyProfile, insertWorkspace } = await import('../../src/storage/repo.ts');
  const { coverageContractHash } = await import('../../src/workspaces/coverage.ts');
  const db = openRegistryDb(path.join(stateDir, 'registry.sqlite'));
  const provider = mock ? 'mock' : 'codex';
  const coverage = { source_prefixes: ['src'], non_source_prefixes: [], excluded_prefixes: ['.git'] };
  insertProject(db, { project_id: 'p-smoke', display_name: 'Codex smoke', configuration_revision: 1, session_cap: 2, created_at: Date.now() });
  insertCoordinator(db, { coordinator_id: 'node-mcp-client', display_name: 'Plain Node client', allowed_project_ids: ['p-smoke'], revoked: false, config_revision: 1 });
  insertAccount(db, { account_profile_id: 'native-owned', provider, quota_scope_id: 'native-owned', auth_mode: 'cli-owned' });
  insertCoverageProfile(db, { coverage_profile_id: 'cov', version: '1', config: JSON.stringify(coverage), contract_hash: coverageContractHash(coverage) });
  insertPolicyProfile(db, { policy_profile_id: 'pol', version: '1', config: JSON.stringify({ access: 'workspace_write', write_scope: ['src'] }) });
  insertWorkspace(db, { workspace_id: 'ws', project_id: 'p-smoke', mode: 'current', canonical_path: workspace, quarantined: false, quarantine_reason: null, coverage_profile_id: 'cov' });
  db.close();
  const env = { ...process.env, AB_STATE_DIR: stateDir, AB_COORDINATOR_ID: 'node-mcp-client', AB_ROLE: 'daemon' };
  // Native provider registration uses the production environment bootstrap.
  for (const pin of ['AB_CODEX_BIN', 'AB_CLAUDE_BIN', 'AB_CURSOR_BIN', 'AB_ZCODE_BUNDLE', 'AB_ANTIGRAVITY_BIN']) delete env[pin];
  if (!mock) env.AB_CODEX_BIN = binary;
  const daemon = childProcess.spawn(process.execPath, ['--experimental-transform-types', fileURLToPath(import.meta.url), '--instrument-daemon', root], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let daemonStderr = ''; daemon.stderr.on('data', chunk => { daemonStderr += chunk; });
  let bridge; const rpcLog = []; const pending = new Map(); let nextId = 1; let buffer = '';
  const evidence = { provider, requestedModel: model, requestedEffort: effort, caller: 'plain Node.js MCP client', transport: 'client -> stdio bridge -> private named pipe/socket -> daemon -> native adapter', platform: process.platform, node: process.version, root, workspace, marker: 'AB_' + randomUUID().replaceAll('-', ''), startedAt: new Date().toISOString(), status: 'running', turns: [] };
  const save = () => writeFileSync(path.join(root, 'evidence.json'), JSON.stringify({ ...evidence, rpcLog }, null, 2));
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    rpcLog.push({ direction: 'request', id, method, params });
    bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const tool = async (name, args = {}) => {
    const result = await rpc('tools/call', { name, arguments: args });
    const payload = JSON.parse(result.content[0].text);
    if (result.isError || payload.ok === false) throw new Error(`${name}: ${JSON.stringify(payload)}`);
    return payload;
  };
  try {
    const readyDeadline = Date.now() + 15000;
    while (!daemonStderr.includes('daemon listening')) {
      if (daemon.exitCode !== null || Date.now() > readyDeadline) throw new Error(`Daemon readiness failed: ${daemonStderr}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    bridge = childProcess.spawn(process.execPath, ['--experimental-transform-types', 'src/bridge/main-stdio.ts'], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let bridgeStderr = ''; bridge.stderr.on('data', chunk => { bridgeStderr += chunk; });
    bridge.stdout.setEncoding('utf8'); bridge.stdout.on('data', chunk => {
      buffer += chunk; let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (!line.trim()) continue;
        const msg = JSON.parse(line); rpcLog.push({ direction: 'response', ...msg });
        const waiter = pending.get(msg.id);
        if (waiter) { pending.delete(msg.id); clearTimeout(waiter.timer); if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error))); else waiter.resolve(msg.result); }
      }
    });
    bridge.once('exit', () => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`Bridge exited: ${bridgeStderr}`)); } pending.clear(); });
    evidence.initialize = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'plain-node-smoke', version: '1.0' } });
    bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    evidence.tools = (await rpc('tools/list')).tools.map(tool => tool.name);
    evidence.brokerStatus = await tool('broker_status');
    const spawn = await tool('agent_session_spawn', { project_id: 'p-smoke', idempotency_key: randomUUID(), provider, account_profile_id: 'native-owned', model, effort, role: 'worker', instructions: 'Run only the requested short response. Do not use tools, edit files, browse, delegate or call any MCP server.', workspace: { mode: 'current', workspace_id: 'ws' }, policy_profile_id: 'pol' });
    evidence.session = spawn; let snapshot = spawn.initial_snapshot_id;
    for (let i = 0; i < 2; i++) {
      const goal = i === 0 ? `Remember this marker for this conversation: ${evidence.marker}. Reply with exactly the marker.` : 'Return exactly the marker from the previous turn in this conversation. No tools or explanation.';
      const sent = await tool('agent_session_send', { session_id: spawn.session_id, idempotency_key: randomUUID(), task: { goal, artifact_refs: [] }, workspace_precondition: { expected_snapshot_id: snapshot } });
      const turn = { request: sent, goal, status: null, result: null, session: null, events: null }; evidence.turns.push(turn); save();
      const deadline = Date.now() + 120000;
      while (true) {
        turn.status = await tool('agent_turn_status', { turn_id: sent.turn_id });
        if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN', 'TIMED_OUT', 'ABANDONED'].includes(turn.status.state)) break;
        if (Date.now() > deadline) {
          await tool('agent_turn_cancel', { turn_id: sent.turn_id, idempotency_key: randomUUID() });
          throw new Error('Native turn deadline exceeded; cancellation requested, no retry.');
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      turn.result = await tool('agent_turn_result', { turn_id: sent.turn_id });
      turn.session = await tool('agent_session_status', { session_id: spawn.session_id });
      turn.events = await tool('agent_turn_events', { turn_id: sent.turn_id });
      save(); assert.equal(turn.status.state, 'SUCCEEDED', JSON.stringify(turn.result));
      if (!mock) assert.equal(turn.result.agent_reported.summary.trim(), evidence.marker);
      snapshot = turn.result.broker_observed.final_snapshot_id;
      console.log(`PASS turn ${i + 1}: ${turn.status.state}; native ref ${turn.session.native_conversation_ref ?? 'see session evidence'}`);
    }
    await tool('agent_session_stop', { session_id: spawn.session_id, idempotency_key: randomUUID() });
    for (let i = 0; i < 50; i++) {
      evidence.closedSession = await tool('agent_session_status', { session_id: spawn.session_id });
      if (evidence.closedSession.state === 'CLOSED') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(evidence.closedSession.state, 'CLOSED');
    evidence.status = 'smoke-passed';
  } catch (err) { evidence.status = 'failed'; evidence.error = String(err); process.exitCode = 1; }
  finally {
    evidence.finishedAt = new Date().toISOString(); save();
    if (bridge) { const exited = once(bridge, 'close'); bridge.stdin.end(); await exited; }
    const stopped = once(daemon, 'close'); daemon.stdin.end(); await stopped;
    writeFileSync(path.join(root, 'daemon.stderr.private.txt'), daemonStderr);
    console.log(`${evidence.status}: ${root}`);
    if (evidence.error) console.error(evidence.error);
  }
}
