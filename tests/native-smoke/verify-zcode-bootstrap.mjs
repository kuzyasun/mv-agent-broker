// Offline validation of the retained original ZCode bootstrap probes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const base = new URL('../../docs/native-smoke/2026-09-30-zcode-bootstrap/', import.meta.url);
const load = (name) => JSON.parse(readFileSync(new URL(name, base), 'utf8'));
const model = load('app-server-model.evidence.json');
const catalog = load('app-server-catalog.evidence.json');
const print = load('standalone-print.evidence.json');
const cause = load('standalone-failure.evidence.json');
const readiness = load('native-readiness.evidence.json');
const desktop = load('desktop-catalog.evidence.json');
const postLogin = load('post-login-readiness.evidence.json');
const mistaken = load('misrouted-model-command.evidence.json');
const smoke = load('standalone-resume.evidence.json');
const runtime = load('standalone-runtime.evidence.json');
for (const evidence of [model, catalog, print]) {
  assert.equal(evidence.desktopSettingsHashBefore, evidence.desktopSettingsHashAfter);
  assert.equal(evidence.desktopSettingsUnchanged, true);
  assert.equal(evidence.inferenceSends, 0);
  assert.equal(evidence.processes.length, 1);
  assert.ok(evidence.processes[0].exitCode !== null);
  assert.ok(!evidence.operations.some((operation) => operation.method === 'session/send'));
}
assert.equal(model.status, 'failed');
assert.equal(model.capabilities.independentPlanState, true);
assert.ok(model.error.includes('Provider Registry'));
assert.ok(model.error.includes('account:zai-individual-coding-plan/GLM-5.3-Flash'));
assert.equal(catalog.status, 'probe-passed');
assert.match(catalog.createdSnapshot.session.sessionId, /^sess_/);
assert.deepEqual(catalog.createdSnapshot.settings.model.available, []);
assert.equal(catalog.createdSnapshot.protocol.name, 'ZCode Protocol');
assert.equal(catalog.createdSnapshot.protocol.version, 1);
assert.equal(print.promptAttempts, 1);
assert.equal(print.processes[0].exitCode, 1);
assert.equal(print.status, 'failed');
assert.equal(cause.error.cause.code, 'CONFIGURATION_ERROR');
assert.equal(cause.error.cause.message, 'Select a model before continuing');
assert.equal(readiness.hasZaiOAuthMetadata, true);
assert.equal(readiness.hasZaiAccountScopedCodingPlanKey, true);
assert.equal(readiness.hasZaiStandaloneIdentity, false);
for (const evidence of [desktop, postLogin, mistaken, smoke]) {
  assert.equal(evidence.desktopProviderConfigHashBefore, evidence.desktopProviderConfigHashAfter);
  assert.equal(evidence.desktopProviderConfigUnchanged, true);
}
assert.equal(desktop.status, 'probe-passed');
assert.deepEqual(desktop.createdSnapshot.settings.model.available, []);
assert.equal(desktop.appServerInferenceSends, 0);
assert.equal(postLogin.hasStandaloneIdentity, true);
assert.equal(postLogin.hasAccountScopedKey, true);
assert.equal(postLogin.generationAttempts, 0);
assert.deepEqual(postLogin.processes, []);
// The original readiness status/counter was wrong: /model was sent to inference.
assert.equal(mistaken.readiness.usage.modelRequestCount, 2);
assert.equal(mistaken.readiness.usage.totalTokens, 52413);
assert.equal(smoke.status, 'smoke-passed');
assert.equal(smoke.generationAttempts, 2);
assert.equal(smoke.processes.length, 2);
const [first, second] = smoke.processes;
assert.equal(first.exitCode, 0);
assert.equal(second.exitCode, 0);
assert.equal(first.timedOut, false);
assert.equal(second.timedOut, false);
assert.notEqual(first.pid, second.pid);
assert.ok(Date.parse(first.finishedAt) <= Date.parse(second.startedAt));
assert.match(smoke.first.sessionId, /^sess_/);
assert.equal(smoke.first.sessionId, smoke.second.sessionId);
assert.equal(smoke.first.response.trim(), smoke.marker);
assert.equal(smoke.second.response.trim(), smoke.marker);
assert.ok(first.args[first.args.indexOf('--prompt') + 1].includes(smoke.marker));
assert.ok(!second.args[second.args.indexOf('--prompt') + 1].includes(smoke.marker));
assert.equal(second.args[second.args.indexOf('--resume') + 1], smoke.first.sessionId);
for (const process of smoke.processes) {
  assert.equal(process.result.usage.modelRequestCount, 1);
  assert.equal(process.result.projection.status, 'idle');
  assert.equal(process.observedModelRequests.length, 1);
  const request = process.observedModelRequests[0];
  assert.equal(request.modelId, 'GLM-5.3-Flash');
  assert.equal(request.providerId, 'account:zai-individual-coding-plan');
  assert.equal(request.attempt, 1);
  assert.equal(request.finishReason, 'stop');
}
const configEvents = runtime.filter((event) => event.event === 'bootstrap.app.startup.runtime_config.completed');
assert.equal(configEvents.length, 2);
assert.equal(configEvents[0].context.model, 'account:zai-individual-coding-plan/GLM-5.3-Flash');
for (const event of configEvents) {
  // Resume restores the persisted selection after this startup config event;
  // the actual model is established by network events on both turns below.
  assert.equal(event.context.mcpEnabled, false);
  assert.equal(event.context.memoryEnabled, false);
  assert.equal(event.context.memoryUse, false);
  assert.equal(event.context.workingDirectory, smoke.workspace);
}
const network = runtime.filter((event) => event.event === 'model.network.completed');
assert.equal(network.length, 2);
for (const event of network) {
  assert.equal(event.context.modelId, 'GLM-5.3-Flash');
  assert.equal(event.context.providerId, 'account:zai-individual-coding-plan');
}
assert.equal(smoke.first.usage.totalTokens + smoke.second.usage.totalTokens, 37458);
assert.equal(mistaken.readiness.usage.totalTokens + smoke.first.usage.totalTokens + smoke.second.usage.totalTokens, 89871);
console.log('PASS: retained bootstrap failures, Desktop catalog, CLI login readiness, corrected model/resume across processes, native usage and unchanged Desktop config.');
