// Offline evidence consistency only: no native CLI, account, or quota access.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const base = new URL('../../docs/native-smoke/2026-10-01-dogfood/', import.meta.url);
const evidence = JSON.parse(readFileSync(new URL('dogfood.evidence.json', base), 'utf8'));
assert.equal(evidence.schema_version, 1);
assert.equal(evidence.usage, 'unknown');
const runs = new Map(evidence.runs.map(run => [run.name, run]));
assert.equal(runs.size, 8);
for (const run of runs.values()) {
  assert(run.started_at && run.finished_at);
  for (const turn of run.turns) {
    assert(['zcode', 'antigravity', 'cursor', 'mock'].includes(turn.provider));
    assert(turn.session_id.startsWith('session-') && turn.turn_id.startsWith('turn-'));
    assert.equal(turn.execution_started, true);
    if (turn.state === 'SUCCEEDED') assert(turn.native_conversation_ref);
    if (turn.state === 'TIMED_OUT') assert.equal(turn.termination_reason, 'deadline');
  }
}
const start = runs.get('start-plan-attempt').turns[0];
assert.equal(start.requested_model, 'account:zai-start-plan/GLM-5.3-Flash');
assert.equal(start.state, 'FAILED'); // Not quota exhaustion or successful fallback.
const writer = runs.get('antigravity-deadlines').turns[0];
assert.equal(writer.state, 'SUCCEEDED');
assert(writer.baseline_snapshot_id && writer.final_snapshot_id);
const partial = runs.get('zcode-partial-regression').turns[0];
assert.equal(partial.state, 'TIMED_OUT');
assert.equal(partial.final_snapshot_id, null);
for (const [name, file, marker] of [
  ['cursor-ask-final-review', 'cursor-review.md', 'Review findings'],
  ['glm-high-shutdown-review', 'glm-review.md', 'no blocker/major findings'],
]) {
  const review = runs.get(name).turns.find(turn => turn.role === 'reviewer');
  assert.equal(review.state, 'SUCCEEDED');
  const report = readFileSync(new URL(file, base), 'utf8');
  assert(report.includes(review.turn_id) && report.includes(marker));
}
console.log('PASS: selected native development successes/failures, deadline outcomes and delivered static review reports; quota/enforcement remain unknown.');
