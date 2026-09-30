// Opt-in, quota-consuming adapter smoke test; excluded from npm test.
// Run sequentially: node tests/native-smoke/provider-spike.mjs <provider> [model] [Cursor display name]
// `models` only discovers the Antigravity catalog; it does not send a prompt.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const provider = process.argv[2];
if (!['models', 'antigravity', 'zcode', 'cursor', 'claude-code'].includes(provider)) {
  throw new Error('Select models, antigravity, zcode, cursor, or claude-code explicitly.');
}
const model = process.argv[3] ?? '';
const expectedCursorModel = process.argv[4] ?? null;
if (provider === 'cursor' && !expectedCursorModel) throw new Error('Cursor requires the expected display name from --list-models as the fourth argument.');
if (['antigravity', 'zcode', 'cursor', 'claude-code'].includes(provider) && !model) throw new Error('Explicit model required.');
const root = path.resolve('.state/native-smoke', new Date().toISOString().replace(/[:.]/g, '-') + '-' + provider);
const workspace = path.join(root, 'workspace');
mkdirSync(workspace, { recursive: true });
if (provider === 'zcode') {
  const userConfigPath = path.join(process.env.USERPROFILE, '.zcode/cli/config.json');
  const userConfig = existsSync(userConfigPath) ? JSON.parse(readFileSync(userConfigPath, 'utf8')) : {};
  writeFileSync(path.join(workspace, 'zcode.json'), JSON.stringify({ features: { mcp: false, memory: false }, memory: { use: false },
    plugins: { enabledPlugins: Object.fromEntries(Object.keys(userConfig.plugins?.enabledPlugins ?? {}).map((id) => [id, false])) } }));
}
const redact = (text) => text
  .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
  .replace(/((?:access_token|refresh_token|api_key|apiKey|client_secret)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]');
const records = [];
const originalSpawn = childProcess.spawn;
childProcess.spawn = function (binary, args, options) {
  const record = { binary, args, cwd: options?.cwd, pid: null, exitCode: null, stdout: '', stderr: '', startedAt: new Date().toISOString() };
  if (provider === 'zcode' && options?.env?.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) {
    record.privateProviderConfig = JSON.parse(readFileSync(options.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, 'utf8'));
    record.privateProviderConfigPath = options.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  }
  records.push(record);
  const child = originalSpawn(binary, args, options);
  if (provider === 'claude-code' && child.stdin) {
    const originalEnd = child.stdin.end;
    child.stdin.end = function (...endArgs) {
      const input = endArgs[0];
      if (typeof input === 'string' || Buffer.isBuffer(input)) record.stdin = input.toString();
      return originalEnd.apply(this, endArgs);
    };
  }
  record.pid = child.pid ?? null;
  child.stdout?.on('data', (chunk) => { record.stdout = (record.stdout + chunk.toString()).slice(-500_000); });
  child.stderr?.on('data', (chunk) => { record.stderr = (record.stderr + chunk.toString()).slice(-100_000); });
  child.on('close', (code) => {
    record.exitCode = code; record.finishedAt = new Date().toISOString();
    // Read selected native metadata before the adapter deletes its own temp dir.
    const logDir = options?.env?.ZCODE_LOG_DIR;
    if (provider === 'zcode' && logDir && existsSync(logDir)) {
      const events = readdirSync(logDir).filter((file) => file.endsWith('.jsonl')).flatMap((file) => readFileSync(path.join(logDir, file), 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      }));
      record.modelRequests = events.filter((event) => event.event === 'model.network.completed').map((event) => ({
        sessionId: event.sessionId, modelId: event.context?.modelId, providerId: event.context?.providerId,
        attempt: event.context?.attempt, finishReason: event.context?.finishReason,
      }));
      record.runtimeConfigs = events.filter((event) => event.event === 'bootstrap.app.startup.runtime_config.completed').map((event) => ({
        mcpEnabled: event.context?.mcpEnabled, memoryEnabled: event.context?.memoryEnabled, mode: event.context?.mode,
      }));
    }
  });
  return child;
};
syncBuiltinESMExports();
const evidence = { provider, requestedModel: model || null, platform: process.platform, node: process.version,
  startedAt: new Date().toISOString(), scope: 'adapter-only; no broker lifecycle/profile acceptance',
  usage: 'unknown; not exposed by adapter', turns: [] };
if (provider === 'cursor') evidence.expectedModelDisplayName = expectedCursorModel;
function save() {
  writeFileSync(path.join(root, 'evidence.json'), redact(JSON.stringify({ ...evidence, processes: records }, null, 2)));
}
const agy = process.env.AB_ANTIGRAVITY_BIN ?? path.join(process.env.LOCALAPPDATA, 'agy/bin/agy.exe');
const bundle = process.env.AB_ZCODE_BUNDLE ?? path.join(process.env.LOCALAPPDATA, 'Programs/ZCode/resources/glm/zcode.cjs');

if (provider === 'models') {
  const child = childProcess.spawn(agy, ['models'], { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const timer = setTimeout(() => {
    if (child.pid && child.exitCode === null) childProcess.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  }, 60_000);
  await new Promise((resolve) => { child.on('close', resolve); child.on('error', (e) => { evidence.error = String(e); resolve(); }); });
  clearTimeout(timer);
  save();
  console.log(redact(records[0]?.stdout ?? ''));
  console.log(JSON.stringify({ evidence: path.join(root, 'evidence.json'), exitCode: records[0]?.exitCode, stderrTail: redact(records[0]?.stderr.slice(-1000) ?? '') }));
  process.exitCode = records[0]?.exitCode === 0 ? 0 : 1;
} else {
  const { AntigravityAdapter } = await import('../../src/providers/antigravity/antigravityAdapter.ts');
  const { ZcodeAdapter } = await import('../../src/providers/zcode/zcodeAdapter.ts');
  const { CursorAdapter } = await import('../../src/providers/cursor/cursorAdapter.ts');
  const { ClaudeAdapter } = await import('../../src/providers/claude/claudeAdapter.ts');
  const adapter = provider === 'antigravity' ? new AntigravityAdapter({ binary: agy })
    : provider === 'cursor' ? new CursorAdapter({ binary: process.env.AB_CURSOR_BIN ?? path.join(process.env.LOCALAPPDATA, 'cursor-agent/cursor-agent.ps1') })
    : provider === 'claude-code' ? new ClaudeAdapter({ binary: process.env.AB_CLAUDE_BIN ?? path.join(process.env.USERPROFILE, '.local/bin/claude.exe') })
    : new ZcodeAdapter({ bundlePath: bundle, nodeBinary: process.execPath, mode: 'plan', builtinProviderConfigPath: process.env.AB_ZCODE_BUILTIN_CONFIG });
  evidence.adapterVersion = adapter.adapterVersion;
  const marker = 'AB_' + randomUUID().replaceAll('-', '');
  const session = randomUUID();
  let nativeRef = null;
  // A fresh turn and, only if the adapter exposes a native ID, one explicit resume.
  for (let index = 0; index < 2; index++) {
    const prompt = index === 0
      ? `Remember this marker for the next turn: ${marker}. Reply exactly ${marker}. Do not use tools, read files, run commands, or change any file.`
      : 'Return only the exact marker I asked you to remember in the previous turn. Do not use tools, read files, run commands, or change any file.';
    const deadline = Date.now() + 90_000;
    const events = [];
    let acquired = 0;
    const turn = { index, requestedNativeRef: nativeRef, events };
    evidence.turns.push(turn);
    try {
      adapter.preflight({});
      turn.result = await adapter.executeTurn({ turn_id: randomUUID(), session_id: session, role: 'worker', provider,
        account_profile_id: 'local-cli-owned', requested_model: model, requested_effort: null,
        instructions_hash: 'native-smoke', native_conversation_ref: nativeRef, task_envelope: prompt,
        workspace_mode: 'current', workspace_path: workspace, deadline_at: deadline, clock: { now: () => Date.now() } },
      { acquireDispatchPermission: () => { acquired++; }, cancellationRequested: () => Date.now() >= deadline ? 'smoke-hard-deadline' : null },
      (event) => events.push(event));
      turn.markerMatched = turn.result.agent_reported?.summary.trim() === marker;
      turn.dispatchGateCalls = acquired;
      if (!turn.markerMatched || acquired !== 1) { evidence.status = 'failed-marker-or-gate'; break; }
      const returnedRef = turn.result.native_conversation_ref;
      if (provider === 'antigravity') {
        const processRecord = records.at(-1);
        const stream = processRecord.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        }).filter(Boolean);
        const init = stream.find((event) => event.event === 'init');
        const result = stream.findLast((event) => event.event === 'result');
        turn.observedModel = init?.init?.model ?? null;
        turn.observedNativeRef = init?.conversation_id ?? null;
        turn.rawResultUsage = result?.result?.usage ?? null;
        if (processRecord.exitCode !== 0 || turn.observedModel !== model ||
            !returnedRef || turn.observedNativeRef !== returnedRef ||
            result?.result?.status !== 'SUCCESS' || result?.result?.conversation_id !== returnedRef) {
          evidence.status = 'failed-native-observation';
          break;
        }
      } else if (provider === 'cursor' || provider === 'claude-code') {
        const processRecord = records.at(-1);
        const stream = processRecord.stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => {
          try { return [JSON.parse(line)]; } catch { return []; }
        });
        const init = stream.find((event) => event.type === 'system' && event.subtype === 'init');
        const result = stream.findLast((event) => event.type === 'result');
        turn.observedModel = init?.model ?? null;
        turn.observedNativeRef = init?.session_id ?? null;
        turn.rawResultUsage = result?.usage ?? null;
        if (provider === 'claude-code') {
          turn.rawModelUsage = result?.modelUsage ?? null;
          turn.reportedCostUsd = result?.total_cost_usd ?? null;
          turn.permissionMode = init?.permissionMode ?? null;
          turn.assistantModels = stream.filter(event => event.type === 'assistant').map(event => event.message?.model);
        }
        // Native init.model can be a display name, not the requested catalog ID.
        const expectedModel = provider === 'cursor' ? expectedCursorModel : model;
        if (processRecord.exitCode !== 0 || turn.observedModel !== expectedModel || !returnedRef ||
            turn.observedNativeRef !== returnedRef || result?.session_id !== returnedRef ||
            result?.is_error !== false || result?.result?.trim() !== marker) {
          evidence.status = 'failed-native-observation'; break;
        }
      } else if (provider === 'zcode') {
        const processRecord = records.at(-1);
        const raw = JSON.parse(processRecord.stdout);
        turn.rawResultUsage = raw.usage;
        turn.observedNativeRef = raw.sessionId;
        turn.modelRequests = processRecord.modelRequests;
        const expectedModel = model.split('/').at(-1);
        if (processRecord.exitCode !== 0 || raw.sessionId !== returnedRef || raw.response.trim() !== marker ||
            !turn.modelRequests?.length || turn.modelRequests.some((request) => request.modelId !== expectedModel || request.providerId !== 'account:zai-individual-coding-plan') ||
            existsSync(processRecord.privateProviderConfigPath)) {
          evidence.status = 'failed-native-observation'; break;
        }
      }
      if (index === 0) {
        if (!returnedRef) { evidence.status = 'headless-passed-native-ref-absent'; break; }
        nativeRef = returnedRef;
      } else {
        evidence.status = returnedRef === nativeRef ? 'headless-and-resume-passed' : 'failed-ref-continuity';
      }
    } catch (error) {
      turn.error = { name: error.name, message: error.message, code: error.code, details: error.details };
      turn.dispatchGateCalls = acquired;
      evidence.status = 'failed';
      break;
    } finally { save(); }
  }
  evidence.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ status: evidence.status, turns: evidence.turns.length, evidence: path.join(root, 'evidence.json'),
    results: evidence.turns.map(({ result, error, markerMatched }) => ({ result, error, markerMatched })) }, null, 2));
  process.exitCode = evidence.status?.startsWith('headless') ? 0 : 1;
}
