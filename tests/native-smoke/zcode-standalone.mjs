// Opt-in native CLI probe. Readiness inspects local metadata; smoke permits two model turns.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

const mode = process.argv[2] ?? 'readiness';
assert.ok(['readiness', 'smoke'].includes(mode), 'Select readiness or smoke');
const root = path.resolve('.state/native-smoke', new Date().toISOString().replace(/[:.]/g, '-') + '-zcode-standalone');
const workspace = path.join(root, 'workspace');
mkdirSync(workspace, { recursive: true });
const bundle = process.env.AB_ZCODE_BUNDLE ?? path.join(process.env.LOCALAPPDATA, 'Programs/ZCode/resources/glm/zcode.cjs');
const builtin = path.join(root, 'zcode-builtin.json');
copyFileSync(path.resolve(path.dirname(bundle), '../config/provider/zcode-builtin.json'), builtin);
const personal = path.join(root, 'provider_config.json');
const selection = { providerId: 'account:zai-individual-coding-plan', modelId: 'GLM-5.3-Flash', options: { reasoningLevel: 'low' } };
writeFileSync(personal, JSON.stringify({ schemaVersion: 1, config: {
  providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] }, defaultModelSelection: selection,
} }));
const userConfig = JSON.parse(readFileSync(path.join(os.homedir(), '.zcode/cli/config.json'), 'utf8'));
writeFileSync(path.join(workspace, 'zcode.json'), JSON.stringify({
  features: { mcp: false, memory: false }, memory: { use: false },
  plugins: { enabledPlugins: Object.fromEntries(Object.keys(userConfig.plugins?.enabledPlugins ?? {}).map((id) => [id, false])) },
}));
const desktopConfig = path.join(os.homedir(), '.zcode/v2/provider_config.json');
const hash = (file) => { try { return createHash('sha256').update(readFileSync(file)).digest('hex'); } catch { return null; } };
const keys = Object.keys(JSON.parse(readFileSync(path.join(process.env.ZCODE_DATA_BASE_DIR ?? os.homedir(), '.zcode/v2/credentials.json'), 'utf8')));
const evidence = { mode, root, workspace, bundle, selection, node: process.version,
  startedAt: new Date().toISOString(), desktopProviderConfigHashBefore: hash(desktopConfig),
  hasStandaloneIdentity: keys.includes(`account-provider:${selection.providerId}:identity`),
  hasAccountScopedKey: keys.some((key) => key.startsWith(`account-provider:coding-plan:${selection.providerId}:account:`) && key.endsWith(':api-key')),
  credentialValuesDisplayedOrCopied: false, generationAttempts: 0, processes: [],
};
const redact = (key, value) => /^(?:token|access[_-]?token|refresh[_-]?token|jwt[_-]?token|id[_-]?token|secret|client[_-]?secret|password|api[_-]?key|authorization|credentials?)$/i.test(key)
  ? '[REDACTED]' : typeof value === 'string' ? value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]') : value;
const save = () => writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(evidence, redact, 2));
async function run(prompt, resume) {
  const args = [bundle, '--prompt', prompt, '--json', '--mode', 'plan', '--cwd', workspace,
    ...(resume ? ['--resume', resume] : []), '--disallowed-tools', 'Bash', 'Write', 'Edit'];
  const record = { args, pid: null, exitCode: null, stdout: '', stderr: '', startedAt: new Date().toISOString(), timedOut: false };
  evidence.processes.push(record);
  const child = spawn(process.execPath, args, { cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
    ZCODE_LOG_DIR: path.join(root, 'log'),
  } });
  record.pid = child.pid; save();
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (data) => { record.stdout += data; save(); });
  child.stderr.on('data', (data) => { record.stderr += data; save(); });
  const timer = setTimeout(() => {
    record.timedOut = true;
    if (child.pid && child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  }, 90000);
  try {
    await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code) => { record.exitCode = code; resolve(); }); });
  } finally { clearTimeout(timer); record.finishedAt = new Date().toISOString(); save(); }
  assert.equal(record.timedOut, false, 'Native CLI timed out');
  assert.equal(record.exitCode, 0, record.stderr || 'Native CLI failed');
  record.result = JSON.parse(record.stdout);
  assert.match(record.result.sessionId, /^sess_/);
  const events = readFileSync(path.join(root, 'log', 'zcode-' + new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line)).filter((event) => event.sessionId === record.result.sessionId && event.traceId === record.result.traceId);
  record.observedModelRequests = events.filter((event) => event.event === 'model.network.completed').map((event) => ({
    modelId: event.context.modelId, providerId: event.context.providerId, querySource: event.context.querySource,
    attempt: event.context.attempt, finishReason: event.context.finishReason,
  }));
  assert.ok(record.observedModelRequests.length > 0, 'Native model request evidence missing');
  for (const request of record.observedModelRequests) {
    assert.equal(request.modelId, selection.modelId, 'Native request used a different model');
    assert.equal(request.providerId, selection.providerId, 'Native request used a different provider');
  }
  return record.result;
}
try {
  assert.ok(evidence.hasStandaloneIdentity && evidence.hasAccountScopedKey, 'Native CLI account registration missing');
  // /model under --prompt is not a safe metadata query in CLI 0.16.9:
  // it can be forwarded to the model. Do not invoke it here.
  evidence.readiness = 'local-account-registration-present; model execution verified only in smoke mode';
  if (mode === 'smoke') {
    const marker = 'ZC_' + randomBytes(10).toString('hex');
    evidence.marker = marker;
    evidence.generationAttempts++;
    const first = await run(`Remember this marker for this conversation: ${marker}. Reply with only the marker. Do not use tools or change files.`);
    assert.equal(first.response.trim(), marker, 'First response marker mismatch');
    evidence.first = first;
    evidence.generationAttempts++;
    const second = await run('What marker did I ask you to remember earlier in this conversation? Reply with only that marker. Do not use tools or change files.', first.sessionId);
    evidence.second = second;
    assert.equal(second.sessionId, first.sessionId, 'Native resume changed session ID');
    assert.equal(second.response.trim(), marker, 'Native resume marker mismatch');
  }
  evidence.status = mode + '-passed';
} catch (error) { evidence.status = 'failed'; evidence.error = error.message; }
finally {
  evidence.desktopProviderConfigHashAfter = hash(desktopConfig);
  evidence.desktopProviderConfigUnchanged = evidence.desktopProviderConfigHashBefore === evidence.desktopProviderConfigHashAfter;
  evidence.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ status: evidence.status, error: evidence.error, generationAttempts: evidence.generationAttempts,
    desktopProviderConfigUnchanged: evidence.desktopProviderConfigUnchanged, evidence: path.join(root, 'evidence.json') }, null, 2));
  process.exitCode = evidence.status.endsWith('-passed') && evidence.desktopProviderConfigUnchanged ? 0 : 1;
}
