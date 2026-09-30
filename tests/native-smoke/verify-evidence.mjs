// Offline assertions over the retained original smoke; no provider launches.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const base = new URL('../../docs/native-smoke/2026-09-30-antigravity-zcode/', import.meta.url);
const load = (name) => JSON.parse(readFileSync(new URL(name, base), 'utf8'));
const agy = load('antigravity.evidence.json');
const zcode = load('zcode.evidence.json');
const catalog = load('antigravity-models.evidence.json');
assert.equal(catalog.processes[0].exitCode, 0);
assert.ok(catalog.processes[0].stdout.includes(agy.requestedModel));
assert.equal(agy.turns.length, 2);
assert.equal(agy.processes.length, 2);
assert.equal(agy.status, 'headless-and-resume-passed');
const streams = agy.processes.map((p) => p.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line)));
const reference = agy.turns[0].result.native_conversation_ref;
const marker = agy.turns[0].result.agent_reported.summary.trim();
assert.match(reference, /^[0-9a-f-]{36}$/i);
assert.match(marker, /^AB_[0-9a-f]{32}$/);
for (let i = 0; i < 2; i++) {
  const turn = agy.turns[i];
  const processRecord = agy.processes[i];
  const init = streams[i].find((event) => event.event === 'init');
  const result = streams[i].findLast((event) => event.event === 'result').result;
  assert.equal(processRecord.exitCode, 0);
  assert.equal(init.init.model, agy.requestedModel);
  assert.equal(init.conversation_id, reference);
  assert.equal(result.conversation_id, reference);
  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.response.trim(), marker);
  assert.equal(turn.result.agent_reported.summary.trim(), marker);
  assert.equal(turn.result.native_conversation_ref, reference);
  assert.equal(turn.dispatchGateCalls, 1);
  assert.ok(turn.events.some((event) => event.type === 'native_ref_obtained' && event.payload.ref === reference));
  assert.equal(processRecord.args[processRecord.args.indexOf('--model') + 1], agy.requestedModel);
}
assert.equal(agy.turns[0].requestedNativeRef, null);
assert.equal(agy.turns[1].requestedNativeRef, reference);
assert.ok(!agy.processes[0].args.includes('--conversation'));
assert.equal(agy.processes[1].args[agy.processes[1].args.indexOf('--conversation') + 1], reference);
assert.ok(!agy.processes[1].args[agy.processes[1].args.indexOf('-p') + 1].includes(marker));
const steps = streams.flat().filter((event) => event.event === 'step_update' && event.step_update.usage);
const finalUsage = streams[1].findLast((event) => event.event === 'result').result.usage;
for (const key of Object.keys(finalUsage)) {
  assert.equal(steps.reduce((sum, event) => sum + event.step_update.usage[key], 0), finalUsage[key], key);
}
assert.equal(zcode.turns.length, 1);
assert.equal(zcode.processes.length, 1);
assert.equal(zcode.status, 'failed');
assert.equal(zcode.processes[0].exitCode, 1);
assert.equal(zcode.processes[0].stdout, '');
assert.equal(zcode.turns[0].error.code, 'PROVIDER_PROTOCOL_ERROR');
assert.ok(zcode.turns[0].error.message.includes('zcode-builtin.json'));
// Workspace inventory is an optional local check, unavailable after cleanup.
const repository = fileURLToPath(new URL('../../', import.meta.url));
let workspaceChecks = 0;
for (const evidence of [agy, zcode]) {
  for (const processRecord of evidence.processes) {
    if (processRecord.cwd.toLowerCase().startsWith(repository.toLowerCase()) && existsSync(processRecord.cwd)) {
      assert.deepEqual(readdirSync(processRecord.cwd), []);
      workspaceChecks++;
    }
  }
}
console.log('PASS: original native model, marker, ID, resume argv, gate, exit, cumulative usage and ZCode failure evidence.');
console.log(`Optional live workspace inventory: ${workspaceChecks} checked; removed or external workspaces skipped.`);
