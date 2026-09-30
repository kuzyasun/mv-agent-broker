// Opt-in ZCode Protocol probe. Default probe performs no model generation.
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

const mode = process.argv[2] ?? 'probe';
if (!['catalog', 'desktop-catalog', 'probe', 'print-probe'].includes(mode)) throw new Error('Select catalog, desktop-catalog, probe or print-probe.');
const root = path.resolve('.state/native-smoke', new Date().toISOString().replace(/[:.]/g, '-') + '-zcode-app-server');
const workspace = path.join(root, 'workspace');
mkdirSync(workspace, { recursive: true });
const bundle = process.env.AB_ZCODE_BUNDLE ?? path.join(process.env.LOCALAPPDATA, 'Programs/ZCode/resources/glm/zcode.cjs');
const builtin = path.resolve(path.dirname(bundle), '../config/provider/zcode-builtin.json');
const personal = mode === 'desktop-catalog'
  ? path.join(process.env.USERPROFILE, '.zcode/v2/provider_config.json')
  : path.join(root, 'provider_config.json');
const selection = { providerId: process.argv[3] ?? 'account:zai-individual-coding-plan',
  modelId: process.argv[4] ?? 'GLM-5.3-Flash', options: { reasoningLevel: 'low' } };
if (mode !== 'desktop-catalog') writeFileSync(personal, JSON.stringify({ schemaVersion: 1, config: {
  providerConfigRules: { providerRules: [] }, modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
  ...(mode === 'print-probe' ? { defaultModelSelection: selection } : {})
} }));
const setting = path.join(process.env.USERPROFILE, '.zcode/v2/provider_config.json');
const hash = (p) => { try { return createHash('sha256').update(readFileSync(p)).digest('hex'); } catch { return null; } };
const originalSettingHash = hash(setting);
const redact = (key, value) => /^(?:token|access[_-]?token|refresh[_-]?token|jwt[_-]?token|id[_-]?token|secret|client[_-]?secret|password|api[_-]?key|authorization|credentials?|credentialKey)$/i.test(key)
  ? '[REDACTED]' : typeof value === 'string' ? value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]') : value;
const evidence = { mode, root, bundle, builtin, personal, node: process.version, startedAt: new Date().toISOString(),
  desktopProviderConfigHashBefore: originalSettingHash, processes: [], operations: [], appServerInferenceSends: 0 };
evidence.selection = selection;
const save = () => writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(evidence, redact, 2));

class Peer {
  pending = new Map();
  messages = [];
  constructor() {
    this.record = { pid: null, exitCode: null, stderr: '', messages: this.messages };
    evidence.processes.push(this.record);
    this.child = spawn(process.execPath, [bundle, 'app-server', '--stdio', '--cwd', workspace], {
      cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
        ...process.env, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
        ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal, ZCODE_LOG_DIR: path.join(root, 'log'),
        ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS: '10000',
      },
    });
    this.record.pid = this.child.pid;
    this.closed = new Promise((resolve) => this.child.on('close', (code) => {
      this.record.exitCode = code;
      for (const pending of this.pending.values()) pending.reject(new Error(`app-server closed: ${code}`));
      resolve();
    }));
    this.child.on('error', (error) => { this.record.error = error.message; });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (text) => { this.record.stderr = (this.record.stderr + text).slice(-20000); save(); });
    this.child.stdin.on('error', () => {});
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { this.messages.push({ nonJson: line.slice(0, 2000) }); return; }
      this.messages.push(message);
      if (message.method && message.id !== undefined) {
        if (message.method === 'session/requestRuntimePreferences') {
          this.write({ id: message.id, result: { nativeSearchEnhancementsEnabled: false, memoryEnabled: false,
            askUserQuestionAutoResolutionEnabled: false, modelContextBudgetStrategy: 'preflight-v1' } });
        } else {
          this.write({ id: message.id, error: { code: -32601, message: 'Unsupported smoke host request' } });
        }
      } else if (message.id !== undefined && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
      save();
    });
  }
  write(message) { this.child.stdin.write(JSON.stringify(message) + '\n'); }
  async request(method, params = {}, timeout = 30000) {
    const id = randomUUID();
    const operation = { method, params };
    evidence.operations.push(operation);
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, timeout);
        this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
        this.write({ id, method, params });
      });
      operation.result = result;
      return result;
    } catch (error) { operation.error = error.message; throw error; }
    finally { save(); }
  }
  async stop() {
    this.child.stdin.end();
    const timer = setTimeout(() => {
      if (this.child.pid && this.child.exitCode === null) spawnSync('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true });
    }, 3000);
    await this.closed;
    clearTimeout(timer);
  }
}

let peer;
try {
  if (mode === 'print-probe') {
    const record = { pid: null, exitCode: null, stdout: '', stderr: '' };
    evidence.processes.push(record);
    evidence.promptAttempts = 1;
    // Explicit separate transport diagnostic. No app-server inference was sent.
    const child = spawn(process.execPath, [bundle, '--prompt', 'Reply exactly ZCODE_PROBE_OK. Do not use tools or change files.',
      '--mode', 'plan', '--cwd', workspace, '--disallowed-tools', 'Bash', 'Write', 'Edit'], {
      cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal,
        ZCODE_LOG_DIR: path.join(root, 'log') },
    });
    record.pid = child.pid;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text) => { record.stdout = (record.stdout + text).slice(-100000); });
    child.stderr.on('data', (text) => { record.stderr = (record.stderr + text).slice(-20000); });
    const timer = setTimeout(() => {
      if (child.pid && child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    }, 90000);
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => { record.exitCode = code; resolve(); });
    });
    clearTimeout(timer);
    if (record.exitCode !== 0) throw new Error(record.stderr || `print process exit ${record.exitCode}`);
    if (record.stdout.trim() !== 'ZCODE_PROBE_OK') throw new Error('Unexpected print response');
    evidence.status = 'print-probe-passed';
  } else {
  peer = new Peer();
  const capabilities = await peer.request('runtime/capabilities');
  evidence.capabilities = capabilities;
  const snapshot = await peer.request('session/create', { workspace: { workspacePath: workspace, workspaceKey: workspace },
    mode: 'plan', ...(['catalog', 'desktop-catalog'].includes(mode) ? {} : { model: selection }), persistence: 'immediate', titleGenerationEnabled: false,
    mcpServers: [], toolAllowlist: [], offPeakToolEnabled: false, dynamicWorkflowEnabled: false });
  evidence.createdSnapshot = snapshot;
  evidence.status = 'probe-passed';
  }
} catch (error) { evidence.status = 'failed'; evidence.error = error.message; }
finally {
  if (peer) await peer.stop();
  evidence.desktopProviderConfigHashAfter = hash(setting);
  evidence.desktopProviderConfigUnchanged = evidence.desktopProviderConfigHashAfter === originalSettingHash;
  evidence.finishedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ status: evidence.status, error: evidence.error, appServerInferenceSends: evidence.appServerInferenceSends,
    promptAttempts: evidence.promptAttempts ?? 0, desktopProviderConfigUnchanged: evidence.desktopProviderConfigUnchanged,
    evidence: path.join(root, 'evidence.json') }, null, 2));
  process.exitCode = evidence.status.endsWith('-passed') ? 0 : 1;
}
