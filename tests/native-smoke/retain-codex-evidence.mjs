// Offline extraction of minimal evidence from the two specific smoke sessions.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const [passedRoot, failedRoot, destination] = process.argv.slice(2);
if (!destination) throw new Error('Provide passed root, initial failure root and destination.');
const load = (root, file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const extract = root => {
  const evidence = load(root, 'evidence.json'); const processes = load(root, 'native-processes.private.json');
  const ref = evidence.turns[0].session.native_conversation_ref;
  const home = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || process.env.HOME, '.codex');
  const day = evidence.startedAt.slice(0, 10).replaceAll('-', '/');
  const directory = path.join(home, 'sessions', day);
  const files = readdirSync(directory).filter(file => file.includes(ref) && file.endsWith('.jsonl'));
  assert.equal(files.length, 1);
  const records = readFileSync(path.join(directory, files[0]), 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const metadata = records.find(record => record.type === 'session_meta').payload;
  const contexts = records.filter(record => record.type === 'turn_context').map(({ payload }) => ({
    turn_id: payload.turn_id, model: payload.model, effort: payload.effort, approval_policy: payload.approval_policy,
    sandbox_policy: payload.sandbox_policy, cwd: payload.cwd,
  }));
  const counters = records.filter(record => record.type === 'event_msg' && record.payload.type === 'token_count')
    .map(({ payload }) => ({ total: payload.info.total_token_usage, last: payload.info.last_token_usage }));
  return { provider: evidence.provider, status: evidence.status, caller: evidence.caller, transport: evidence.transport,
    platform: evidence.platform, node: evidence.node, requestedModel: evidence.requestedModel, requestedEffort: evidence.requestedEffort,
    marker: evidence.marker, startedAt: evidence.startedAt, finishedAt: evidence.finishedAt, tools: evidence.tools,
    session: evidence.session, turns: evidence.turns, closedSession: evidence.closedSession ?? null,
    error: evidence.error ?? null, processes, nativeSession: { id: metadata.id, cli_version: metadata.cli_version, source: metadata.source,
      model_provider: metadata.model_provider, contexts, counters } };
};
mkdirSync(destination, { recursive: true });
for (const [root, name] of [[passedRoot, 'mcp-resume.evidence.json'], [failedRoot, 'initial-delivery-failure.evidence.json']]) {
  writeFileSync(path.join(destination, name), JSON.stringify(extract(root), null, 2) + '\n');
}
console.log('Retained selected MCP/process evidence and native model/usage metadata; full rollouts omitted.');
