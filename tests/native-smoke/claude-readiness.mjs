// Metadata only. No prompts, login, credential reads or inference.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { prepareCommand } from '../../src/providers/common/headless.ts';
const binary = process.env.AB_CLAUDE_BIN ?? path.join(process.env.USERPROFILE, '.local/bin/claude.exe');
function run(args) {
  const prepared = prepareCommand(binary, args);
  const result = spawnSync(prepared.command, prepared.args, { env: process.env, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: prepared.windowsVerbatim, timeout: 30000 });
  if (result.error) throw result.error;
  return result;
}
const version = run(['--version']);
const help = run(['--help']);
const status = run(['auth', 'status', '--json']);
const auth = JSON.parse(status.stdout);
// Retain state/path metadata, never account email, organization IDs or tokens.
const evidence = { timestamp: new Date().toISOString(), provider: 'claude-code', platform: process.platform,
  binary, version: version.stdout.trim(), versionExitCode: version.status, help: help.stdout,
  auth: { loggedIn: auth.loggedIn, authMethod: auth.authMethod, apiProvider: auth.apiProvider,
    subscriptionType: auth.subscriptionType ?? null, configDirectory: auth.configDirectory,
    projectsDirectory: auth.projectsDirectory }, authExitCode: status.status,
  commands: ['--version', '--help', 'auth status --json'], promptsSent: 0 };
const root = path.resolve('.state/native-smoke', new Date().toISOString().replace(/[:.]/g, '-') + '-claude-readiness');
mkdirSync(root, { recursive: true });
writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ version: evidence.version, auth: evidence.auth, evidence: path.join(root, 'evidence.json') }));
process.exitCode = version.status === 0 && help.status === 0 && status.status === 0 && auth.loggedIn === true ? 0 : 1;
