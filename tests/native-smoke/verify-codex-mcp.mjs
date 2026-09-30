// Offline, no native model calls.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const base = new URL('../../docs/native-smoke/2026-09-30-codex/', import.meta.url);
const load = file => JSON.parse(readFileSync(new URL(file, base), 'utf8'));
const e = load('mcp-resume.evidence.json'); const f = load('initial-delivery-failure.evidence.json');
assert.equal(e.status, 'smoke-passed'); assert.equal(e.caller, 'plain Node.js MCP client');
assert.match(e.transport, /stdio bridge.*daemon.*native adapter/);
assert.equal(e.processes.length, 2); assert.equal(e.turns.length, 2); assert.equal(e.tools.length, 13);
assert.equal(e.nativeSession.cli_version, '0.157.0');
assert.equal(e.nativeSession.contexts.length, 2);
assert.notEqual(e.processes[0].pid, e.processes[1].pid);
assert.ok(Date.parse(e.processes[0].finishedAt) <= Date.parse(e.processes[1].startedAt));
assert.equal(e.turns[0].status.continuation, 'new_native_conversation');
assert.equal(e.turns[1].status.continuation, 'native_resume');
assert.equal(e.closedSession.state, 'CLOSED');
for (const [i, process] of e.processes.entries()) {
  const turn = e.turns[i]; const ref = e.nativeSession.id;
  assert.equal(process.exitCode, 0); assert.equal(process.stderr, '');
  assert.ok(process.args.includes('--json')); assert.ok(process.args.includes('--ignore-user-config'));
  assert.equal(process.args[process.args.indexOf('--model') + 1], e.requestedModel);
  assert.equal(turn.status.state, 'SUCCEEDED'); assert.equal(turn.result.execution_status, 'SUCCEEDED');
  assert.equal(turn.result.agent_reported.summary.trim(), e.marker);
  assert.equal(turn.result.quality_status, 'unreviewed'); assert.equal(turn.session.native_conversation_ref, ref);
  assert.ok(turn.result.broker_observed.input_manifest_id); assert.ok(turn.result.broker_observed.final_snapshot_id);
  assert.ok(!JSON.stringify(turn.result.broker_observed).includes(e.marker));
  assert.equal(e.nativeSession.contexts[i].model, e.requestedModel); assert.equal(e.nativeSession.contexts[i].effort, e.requestedEffort);
  // Native observed policy was read-only despite requested workspace-write.
  assert.equal(e.nativeSession.contexts[i].sandbox_policy.type, 'read-only');
  const records = process.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(records[0].type, 'thread.started'); assert.equal(records[0].thread_id, ref);
  assert.equal(records.at(-1).type, 'turn.completed');
  assert.ok(!records.some(record => record.item && record.item.type !== 'agent_message'));
  assert.equal(process.stdin.includes(e.marker), i === 0);
  assert.ok(process.stdin.includes(turn.goal));
}
const second = e.processes[1]; assert.ok(second.args.includes('resume')); assert.equal(second.args.at(-2), e.nativeSession.id);
assert.equal(e.nativeSession.counters.at(-1).total.total_tokens, 36158);
assert.equal(e.nativeSession.counters.reduce((sum, count) => sum + count.last.total_tokens, 0), 36158);
assert.equal(f.processes.length, 1); assert.equal(f.status, 'failed');
assert.ok(!f.processes[0].stdin.includes(f.marker)); assert.equal(f.turns[0].result.agent_reported, null);
assert.equal(f.nativeSession.counters.at(-1).total.total_tokens, 17396);
console.log('PASS: external MCP caller, native model/effort, exact resume after exit, marker continuity, reported result and snapshots, close, cumulative usage, retained initial delivery failure.');
