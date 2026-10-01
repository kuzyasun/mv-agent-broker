// Consistency of retained evidence only. No native inference or account access.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const base = new URL('../../docs/native-smoke/2026-10-01-effective-policy/', import.meta.url);
const evidence = JSON.parse(readFileSync(new URL('effective-policy.evidence.json', base), 'utf8'));
assert.equal(evidence.schema_version, 1);
assert.equal(evidence.usage, 'unknown');
assert.equal(evidence.native_enforcement, 'unknown');
const runs = new Map(evidence.runs.map(run => [run.name, run]));
assert.equal(runs.size, 4);
for (const run of runs.values()) {
  assert.match(run.runtime_commit, /^[a-f0-9]{40}$/);
  assert.equal(run.runtime_files, 47);
  assert(run.started_at && run.finished_at);
  for (const turn of run.turns) {
    assert(['mock', 'zcode', 'antigravity', 'cursor'].includes(turn.provider));
    assert.equal(turn.execution_started, true);
    assert(turn.native_conversation_ref);
  }
}
assert.equal(runs.get('isolation').turns[0].state, 'SUCCEEDED');
assert(evidence.isolation_proof.dirty_source_excluded && evidence.isolation_proof.untracked_source_excluded);
const worker = runs.get('worker').turns[0];
assert.equal(worker.state, 'FAILED');
assert.equal(worker.native_outcome, 'completed');
assert.equal(worker.error_code, 'SCOPE_VIOLATION');
assert.equal(worker.final_snapshot_id, null);
assert.equal(runs.get('design').turns[0].summary_at_cap, true);
const review = runs.get('review');
assert.equal(review.review_source.state, 'FAILED');
assert.equal(review.review_source.turn_id, worker.turn_id);
assert.equal(review.review_source.capture_current, true);
assert.equal(review.turns[0].state, 'SUCCEEDED');
assert(review.turns[0].final_snapshot_id);
assert.equal(review.turns[1].state, 'SUCCEEDED');
assert.equal(review.turns[1].baseline_snapshot_id, worker.baseline_snapshot_id);
assert.equal(review.turns[1].summary_at_cap, false);
assert(readFileSync(new URL('cursor-review.md', base), 'utf8').includes('None found.'));
const mcp = evidence.mcp_smoke;
assert.match(mcp.runtime_commit, /^[a-f0-9]{40}$/);
assert.equal(mcp.runtime_files, 48);
assert.equal(mcp.native_launches, 0);
assert.deepEqual(mcp.rejected.map(error => error.code), ['POLICY_UNSUPPORTED', 'INVALID_REQUEST', 'INVALID_REQUEST', 'INVALID_REQUEST']);
for (const error of mcp.rejected) assert.equal(error.execution_started, false);
for (const count of Object.values(mcp.rejected_counts)) assert.equal(count, 0);
assert.equal(mcp.same_key_reused_for_accepted_spawn, true);
assert.equal(mcp.state, 'SUCCEEDED');
assert.deepEqual(mcp.effective_write_scope, ['src/core']);
assert(mcp.final_snapshot_id);
console.log('PASS: stable runtime isolation, preserved scope failure, separate sealed capture and delivered Cursor review; quota/native enforcement unknown.');
