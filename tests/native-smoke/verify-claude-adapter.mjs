// Offline assertions only; no subprocesses, network or inference.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
const root = new URL('../../docs/native-smoke/2026-09-30-claude/', import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(name, root), 'utf8'));
const readiness = read('initial-readiness.evidence.json');
assert.equal(readiness.version, '2.1.285 (Claude Code)');
assert.equal(readiness.promptsSent, 0);
assert.equal(readiness.auth.loggedIn, false); assert.equal(readiness.authExitCode, 1);
const failure = read('initial-flags-failure.evidence.json');
assert.equal(failure.status, 'failed'); assert.equal(failure.adapterVersion, '0.1.0');
assert.equal(failure.turns.length, 1); assert.equal(failure.processes.length, 1);
assert.match(failure.turns[0].error.message, /stream-json requires --verbose/);
assert(!failure.processes[0].args.includes('--verbose'));
assert.equal(failure.processes[0].exitCode, 1);
const nativeFile = new URL('adapter-resume.evidence.json', root);
if (!existsSync(nativeFile)) {
  console.log('PASS: retained Claude argument failure and unauthenticated metadata; native model/resume remain unverified.');
} else {
  const ready = read('readiness.evidence.json');
  assert.equal(ready.auth.loggedIn, true); assert.equal(ready.promptsSent, 0);
  const evidence = read('adapter-resume.evidence.json');
  assert.equal(evidence.provider, 'claude-code'); assert.equal(evidence.adapterVersion, '0.2.0');
  assert.equal(evidence.status, 'headless-and-resume-passed'); assert.equal(evidence.turns.length, 2);
  assert.equal(evidence.processes.length, 2);
  const ref = evidence.turns[0].result.native_conversation_ref;
  const marker = evidence.turns[0].result.agent_reported.summary;
  assert.match(ref, /^[0-9a-f-]{36}$/); assert.match(marker, /^AB_[a-f0-9]{32}$/);
  assert(new Date(evidence.processes[0].finishedAt) <= new Date(evidence.processes[1].startedAt));
  assert.equal(evidence.turns[0].requestedNativeRef, null);
  assert.equal(evidence.turns[1].requestedNativeRef, ref);
  const totals = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  for (let i = 0; i < 2; i++) {
    const turn = evidence.turns[i]; const proc = evidence.processes[i];
    assert.equal(proc.stdin.includes(marker), i === 0);
    assert.equal(turn.dispatchGateCalls, 1); assert.equal(turn.markerMatched, true);
    assert.equal(turn.result.native_conversation_ref, ref); assert.equal(proc.exitCode, 0);
    assert(proc.args.includes('--verbose')); assert(proc.args.includes('--print'));
    assert.equal(proc.args[proc.args.indexOf('--model') + 1], evidence.requestedModel);
    if (i === 1) assert.equal(proc.args[proc.args.indexOf('--resume') + 1], ref);
    else assert(!proc.args.includes('--resume'));
    assert.deepEqual(turn.events.filter(event => event.type === 'native_ref_obtained'), [{ type: 'native_ref_obtained', payload: { ref } }]);
    const stream = proc.stdout.trim().split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const init = stream.find(event => event.type === 'system' && event.subtype === 'init');
    const result = stream.findLast(event => event.type === 'result');
    assert.equal(init.session_id, ref); assert.equal(init.model, evidence.requestedModel);
    assert.equal(result.is_error, false); assert.equal(result.subtype, 'success');
    assert.equal(result.session_id, ref); assert.equal(result.result.trim(), marker);
    assert.deepEqual(result.usage, turn.rawResultUsage); assert.deepEqual(result.modelUsage, turn.rawModelUsage);
    for (const key of Object.keys(totals)) totals[key] += result.usage[key];
    assert.deepEqual(Object.keys(result.modelUsage), [evidence.requestedModel]);
    const limits = stream.filter(event => event.type === 'rate_limit_event');
    assert(limits.length > 0 && limits.every(event => event.rate_limit_info.status === 'allowed'));
    assert(stream.filter(event => event.type === 'assistant').every(event => event.message.model === evidence.requestedModel));
    assert(!stream.some(event => event.type === 'assistant' && event.message.content.some(part => part.type === 'tool_use')));
  }
  const lastTurn = evidence.turns[1]; const cumulative = lastTurn.rawModelUsage[evidence.requestedModel];
  assert.equal(cumulative.inputTokens, totals.input_tokens);
  assert.equal(cumulative.outputTokens, totals.output_tokens);
  assert.equal(cumulative.cacheReadInputTokens, totals.cache_read_input_tokens);
  assert.equal(cumulative.cacheCreationInputTokens, totals.cache_creation_input_tokens);
  assert.equal(lastTurn.reportedCostUsd, cumulative.costUSD);
  console.log('PASS: Claude adapter native model/identity/marker/resume, process exits, gates and usage evidence.');
}
