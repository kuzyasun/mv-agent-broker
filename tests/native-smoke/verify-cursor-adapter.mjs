// Offline retained-evidence assertions; no subprocesses, network or inference.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../../docs/native-smoke/2026-09-30-cursor/', import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
const readiness = read('readiness.evidence.json');
assert.equal(readiness.version, '2026.09.28-64d2043');
assert.equal(readiness.authenticated, true);
assert.equal(readiness.promptsSent, 0);
assert(readiness.models.some(model => model.id === 'gpt-5.4-mini-none' && model.name === 'GPT-5.4 Mini None'));
const launcher = read('launcher.evidence.json');
assert.equal(launcher.promptsSent, 0);
assert.equal(launcher.attempts[0].withPathext, false);
assert.equal(launcher.attempts[0].stdout, '');
assert.equal(launcher.attempts[1].withPathext, true);
assert.equal(launcher.attempts[1].stdout.trim(), readiness.version);
for (const name of ['initial-launch-failure.evidence.json', 'profile-only-launch-failure.evidence.json']) {
  const failure = read(name);
  assert.equal(failure.status, 'failed'); assert.equal(failure.turns.length, 1);
  assert.equal(failure.processes[0].stdout, ''); assert.equal(failure.processes[0].stderr, '');
  assert.equal(failure.processes[0].exitCode, 0);
}
let requests = 0;
const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
for (const name of ['environment-fixed.evidence.json', 'adapter-resume.evidence.json']) {
  const evidence = read(name);
  assert.equal(evidence.status, 'headless-and-resume-passed');
  assert.equal(evidence.turns.length, 2); assert.equal(evidence.processes.length, 2);
  if (name === 'adapter-resume.evidence.json') {
    assert.equal(evidence.adapterVersion, '0.2.0');
    assert.equal(evidence.expectedModelDisplayName, 'GPT-5.4 Mini None');
  }
  const first = evidence.turns[0].result;
  const ref = first.native_conversation_ref;
  const marker = first.agent_reported.summary;
  assert.match(ref, /^[0-9a-f-]{36}$/); assert.match(marker, /^AB_[a-f0-9]{32}$/);
  assert.equal(evidence.turns[0].requestedNativeRef, null);
  assert.equal(evidence.turns[1].requestedNativeRef, ref);
  assert(new Date(evidence.processes[0].finishedAt) <= new Date(evidence.processes[1].startedAt));
  for (let i = 0; i < 2; i++) {
    const turn = evidence.turns[i]; const proc = evidence.processes[i];
    assert.equal(turn.dispatchGateCalls, 1); assert.equal(turn.markerMatched, true);
    assert.equal(turn.result.native_conversation_ref, ref);
    assert.deepEqual(turn.events.filter(event => event.type === 'native_ref_obtained'), [{ type: 'native_ref_obtained', payload: { ref } }]);
    assert.equal(proc.exitCode, 0); assert.equal(proc.stderr, '');
    assert.equal(proc.args[proc.args.indexOf('--model') + 1], 'gpt-5.4-mini-none');
    if (i === 1) assert.equal(proc.args[proc.args.indexOf('--resume') + 1], ref);
    else assert(!proc.args.includes('--resume'));
    const stream = proc.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
    const init = stream.find(event => event.type === 'system' && event.subtype === 'init');
    const result = stream.findLast(event => event.type === 'result');
    const userText = stream.find(event => event.type === 'user').message.content[0].text;
    assert.equal(init.model, 'GPT-5.4 Mini None'); assert.equal(init.session_id, ref);
    assert.equal(init.apiKeySource, 'login'); assert.equal(init.permissionMode, 'default');
    assert.equal(result.is_error, false); assert.equal(result.subtype, 'success');
    assert.equal(result.session_id, ref); assert.equal(result.result, marker);
    assert.equal(stream.some(event => event.type === 'tool_call'), false);
    assert.equal(userText.includes(marker), i === 0);
    assert.deepEqual(result.usage, turn.rawResultUsage);
    for (const key of Object.keys(totals)) totals[key] += result.usage[key];
    requests++;
  }
}
assert.equal(requests, 4);
assert.deepEqual(totals, { inputTokens: 25548, outputTokens: 96, cacheReadTokens: 24576, cacheWriteTokens: 0 });
console.log(JSON.stringify({ status: 'passed', nativeRequestsRetained: requests, usage: totals, quotaErrorsObserved: 0 }));
