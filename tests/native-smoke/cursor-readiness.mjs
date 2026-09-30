// Metadata only. No prompts, login, token extraction or inference.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { prepareCommand } from '../../src/providers/common/headless.ts';

const binary = process.env.AB_CURSOR_BIN ?? path.join(process.env.LOCALAPPDATA, 'cursor-agent/cursor-agent.ps1');
function run(args) {
  const prepared = prepareCommand(binary, args);
  const result = spawnSync(prepared.command, prepared.args, { env: process.env, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: prepared.windowsVerbatim, timeout: 30000 });
  if (result.error || result.status !== 0) throw new Error(`Cursor metadata ${args.join(' ')} failed (exit ${result.status}).`);
  return result.stdout;
}
const version = run(['--version']).trim();
const help = run(['--help']);
// Discard account email rather than writing the raw status response to evidence.
const authenticated = /logged in as/i.test(run(['status']));
const models = run(['--list-models']).split(/\r?\n/).flatMap(line => {
  const match = /^([a-z0-9][a-z0-9.-]*) - (.+)$/i.exec(line.trim());
  return match ? [{ id: match[1], name: match[2] }] : [];
});
const root = path.resolve('.state/native-smoke', new Date().toISOString().replace(/[:.]/g, '-') + '-cursor-readiness');
mkdirSync(root, { recursive: true });
const evidence = { timestamp: new Date().toISOString(), provider: 'cursor', platform: process.platform,
  binary, version, authenticated, commands: ['--version', '--help', 'status', '--list-models'],
  promptsSent: 0, models, help };
writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ version, authenticated, models: models.length, evidence: path.join(root, 'evidence.json') }));
process.exitCode = authenticated && models.length > 0 ? 0 : 1;
