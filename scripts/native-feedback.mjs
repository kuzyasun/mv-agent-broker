// Opt-in caller-independent Node MCP client harness for the normative
// worker -> review -> fix -> same-reviewer flow.
// No Claude, no Codex, no automatic fallback, no implicit native run.
// node --experimental-transform-types scripts/native-feedback.mjs [config.json]
// node --experimental-transform-types scripts/native-feedback.mjs --mock
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';

const MAX_RPC_BYTES = 12 * 1024 * 1024;
const MAX_LOG_CHARS = 65536;
function logTail(previous, chunk) {
  // Keep startup state only. Vendor stderr is not a trustworthy report channel.
  const text = String(chunk);
  return (previous + (text.includes('daemon listening') ? 'daemon listening\n' : '[stderr withheld]\n')).slice(-MAX_LOG_CHARS);
}
async function boundedClose(child, closed, requestStop = true) {
  if (!child) return true;
  if (!closed) return false;
  if (requestStop && child.exitCode === null && child.signalCode === null) {
    try { child.stdin.end(); } catch { /* close receipt still required */ }
  }
  let timer;
  try {
    return await Promise.race([closed.then(value => value !== false, () => false), new Promise(r => { timer=setTimeout(() => r(false),4000); })]);
  } finally { clearTimeout(timer); }
}
function assertNoLinkAncestors(target) {
  let current = path.resolve(target);
  for (;;) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('Refusing symlink ancestor.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current);
    if (current === parent) break;
    current = parent;
  }
}

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

export const AUTHORIZED_PROVIDERS = Object.freeze(['zcode', 'antigravity', 'cursor', 'mock']);
export const FORBIDDEN_PROVIDERS = Object.freeze(['claude', 'codex']);
export const ACCEPTED_RUNTIME_SHA = '3cf17bd5a8f3b3ce09e067521ab26e0e0839596c';
export const INLINE_TOTAL_BYTE_CAP = 16 * 1024;
export const DEFAULT_MAX_REPORT_BYTES = 8 * 1024 * 1024;

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

/**
 * Daemon server subprocess launcher when invoked with --serve <runtime>
 */
if (process.argv[2] === '--serve') {
  process.stdin.resume();
  process.stdin.on('end', () => process.emit('SIGTERM'));
  const runtime = process.argv[3];
  if (process.env.AB_MOCK_FEEDBACK === '1') {
    const { startDaemon, daemonEnvFromProcess } = await import(pathToFileURL(path.join(runtime, 'src/daemon/bootstrap.ts')).href);
    const { startDaemonRpc } = await import(pathToFileURL(path.join(runtime, 'src/daemon/rpc.ts')).href);
    const env = daemonEnvFromProcess(process.env);
    const daemon = await startDaemon(env);
    const mock = daemon.adapters.get('mock');
    if (mock) {
      const activeInterrupts = new Map();
      const origInterrupt = mock.interruptTurn ? mock.interruptTurn.bind(mock) : null;
      mock.interruptTurn = async (turnId) => {
        if (activeInterrupts.has(turnId)) {
          const reject = activeInterrupts.get(turnId);
          activeInterrupts.delete(turnId);
          const { BrokerError } = await import(pathToFileURL(path.join(runtime, 'src/shared/errors.ts')).href);
          reject(new BrokerError("PROVIDER_PROTOCOL_ERROR", "interrupted", { executionStarted: true }));
          return true;
        }
        return origInterrupt ? origInterrupt(turnId) : false;
      };

      const origExecute = mock.executeTurn.bind(mock);
      mock.executeTurn = async (req, gate, onEvent) => {
        // If a plan is already registered for this turn, allow MockAdapter default handling
        if (typeof mock.executedSteps === 'function' && mock.plans?.has(req.turn_id)) {
          return origExecute(req, gate, onEvent);
        }
        gate.acquireDispatchPermission();
        const fs = await import('node:fs');
        const pathMod = await import('node:path');
        const root = req.workspace_path;
        let nativeRef = req.native_conversation_ref;
        if (!nativeRef) {
          nativeRef = req.role === 'worker' ? 'mock-native-worker-ref' : 'mock-native-reviewer-ref';
          onEvent({ type: 'native_ref_obtained', payload: { ref: nativeRef } });
        } else {
          onEvent({ type: 'progress', payload: { label: 'resumed' } });
        }

        // Cancellation scenario support: wait on interrupt
        if (req.task_envelope?.includes('Will be cancelled')) {
          await new Promise((resolve, reject) => {
            activeInterrupts.set(req.turn_id, reject);
            setTimeout(() => {
              activeInterrupts.delete(req.turn_id);
              resolve();
            }, 10000);
          });
        }

        // Mock fault injection: UNKNOWN state
        if (process.env.AB_MOCK_FAULT === 'turn_unknown' && req.role === 'worker' && !req.native_conversation_ref) {
          await daemon.executor.forceUnknownForTest(req.turn_id, new Error('Injected mock UNKNOWN fault'));
          return;
        }

        // Mock fault injection: Active disconnect delay
        if ((process.env.AB_MOCK_FAULT === 'active_disconnect' || process.env.AB_MOCK_ACTIVE_DISCONNECT === '1') && req.role === 'worker' && !req.native_conversation_ref) {
          await new Promise(r => setTimeout(r, 2000));
        }

        if (req.role === 'worker' && !req.native_conversation_ref) {
          // Worker Turn 1: add src/calc.js, remove src/obsolete.js, introduce benign defect into src/math.js
          if (root) {
            fs.mkdirSync(pathMod.join(root, 'src'), { recursive: true });
            fs.writeFileSync(pathMod.join(root, 'src', 'calc.js'), 'export function multiply(a, b) {\n  return a * b;\n}\n');
            fs.writeFileSync(
              pathMod.join(root, 'src', 'math.js'),
              'export function add(a, b) {\n  return a + b;\n}\n\nexport function divide(a, b) {\n  // Benign defect: returns addition instead of division\n  return a + b;\n}\n'
            );
            fs.rmSync(pathMod.join(root, 'src', 'obsolete.js'), { force: true });
          }
          return {
            native_outcome: 'completed',
            native_conversation_ref: nativeRef,
            agent_reported: {
              summary: 'Worker Turn 1 completed: added src/calc.js, removed src/obsolete.js, introduced benign defect in divide function in src/math.js.',
              format_status: 'structured',
            },
          };
        } else if (req.role === 'reviewer' && !req.native_conversation_ref) {
          // Mock fault: R1 failed
          if (process.env.AB_MOCK_FAULT === 'r1_failed') {
            return {
              native_outcome: 'failed',
              native_conversation_ref: nativeRef,
              agent_reported: {
                summary: 'Mock injected fault: R1 review execution failed fatally.',
                format_status: 'text_only',
              },
            };
          }
          // Mock fault: missing report
          if (process.env.AB_MOCK_FAULT === 'missing_report') {
            return {
              native_outcome: 'completed',
              native_conversation_ref: nativeRef,
              agent_reported: {
                summary: '',
                format_status: 'text_only',
              },
            };
          }
          // Mock fault: oversized report (>8 MiB)
          if (process.env.AB_MOCK_FAULT === 'oversized_report') {
            return {
              native_outcome: 'completed',
              native_conversation_ref: nativeRef,
              agent_reported: {
                summary: 'FINDINGS: ' + 'A'.repeat(DEFAULT_MAX_REPORT_BYTES + 1024),
                format_status: 'structured',
              },
            };
          }
          // Mock fault: invalid non-JSON report
          if (process.env.AB_MOCK_FAULT === 'invalid_report') {
            return {
              native_outcome: 'completed',
              native_conversation_ref: nativeRef,
              agent_reported: {
                summary: 'INVALID_FINDINGS_NON_JSON_STRUCTURE',
                format_status: 'text_only',
              },
            };
          }

          // Reviewer R1: review slot inspection, generate findings
          const findingsText = process.env.AB_MOCK_LARGE_FINDINGS === '1'
            ? 'FINDINGS: defect in src/math.js line 5: divide returns a + b instead of a / b. ' + 'x'.repeat(18000)
            : 'FINDINGS: defect in src/math.js line 5: divide returns a + b instead of a / b. Deleted src/obsolete.js absent; src/calc.js added.';
          return {
            native_outcome: 'completed',
            native_conversation_ref: nativeRef,
            agent_reported: {
              summary: findingsText,
              format_status: 'structured',
            },
          };
        } else if (req.role === 'worker' && req.native_conversation_ref) {
          // Mock fault: bad resumed ID
          if (process.env.AB_MOCK_FAULT === 'bad_resumed_id') {
            const corruptedRef = 'mock-native-worker-ref-corrupted';
            onEvent({ type: 'native_ref_obtained', payload: { ref: corruptedRef } });
            return {
              native_outcome: 'completed',
              native_conversation_ref: corruptedRef,
              agent_reported: {
                summary: 'Worker Fix Turn completed with corrupted resume ID.',
                format_status: 'structured',
              },
            };
          }

          // Worker Fix Turn (SAME worker): fix defect in src/math.js
          if (root) {
            fs.writeFileSync(
              pathMod.join(root, 'src', 'math.js'),
              'export function add(a, b) {\n  return a + b;\n}\n\nexport function divide(a, b) {\n  if (b === 0) throw new Error("division by zero");\n  return a / b;\n}\n'
            );
          }
          return {
            native_outcome: 'completed',
            native_conversation_ref: nativeRef,
            agent_reported: {
              summary: 'Worker Fix Turn completed: corrected divide implementation in src/math.js according to findings artifact.',
              format_status: 'structured',
            },
          };
        } else {
          // Reviewer R2 (SAME reviewer): confirm fix
          return {
            native_outcome: 'completed',
            native_conversation_ref: nativeRef,
            agent_reported: {
              summary: 'Reviewer Turn 2 completed: verified defect resolution in S2. Deleted files remain absent, new files readable, tests pass.',
              format_status: 'structured',
            },
          };
        }
      };
    }
    const rpcServer = await startDaemonRpc({
      core: daemon.core,
      coordinatorId: env.coordinatorId,
      stateDir: env.stateDir,
    });
    process.stderr.write(`agent-broker daemon listening ${rpcServer.socketPath}\n`);
    try {
      await new Promise((resolve) => {
        const shutdown = () => {
          process.off('SIGINT', shutdown);
          process.off('SIGTERM', shutdown);
          resolve();
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      });
    } finally {
      try {
        await rpcServer.stop();
      } finally {
        await daemon.stop();
        daemon.db.close();
      }
    }
  } else {
    await import(pathToFileURL(path.join(runtime, 'src/daemon/main.ts')).href);
  }
  process.exit(0);
}

/**
 * Initializes an owned harmless temporary fixture Git repository with generated package/source baseline.
 * Worker operates strictly in this fixture repo and never in the broker main checkout.
 */
export function createFixtureGitRepo(targetDir) {
  mkdirSync(path.join(targetDir, 'src'), { recursive: true });
  mkdirSync(path.join(targetDir, 'tests'), { recursive: true });

  const pkgContent = JSON.stringify({
    name: 'feedback-fixture',
    version: '1.0.0',
    type: 'module',
    scripts: { test: 'node --test tests/*.test.js' },
  }, null, 2) + '\n';
  writeFileSync(path.join(targetDir, 'package.json'), pkgContent);

  const mathContent = `export function add(a, b) {
  return a + b;
}

export function divide(a, b) {
  if (b === 0) throw new Error("division by zero");
  return a / b;
}
`;
  writeFileSync(path.join(targetDir, 'src/math.js'), mathContent);

  const obsoleteContent = 'export const obsolete = true;\n';
  writeFileSync(path.join(targetDir, 'src/obsolete.js'), obsoleteContent);

  const testContent = `import assert from "node:assert/strict";
import test from "node:test";
import { add, divide } from "../src/math.js";

test("add", () => {
  assert.equal(add(1, 2), 3);
});

test("divide", () => {
  assert.equal(divide(4, 2), 2);
  assert.throws(() => divide(1, 0), /division by zero/);
});
`;
  writeFileSync(path.join(targetDir, 'tests/math.test.js'), testContent);

  const gitOpts = { cwd: targetDir, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } };
  execFileSync('git', ['init'], gitOpts);
  execFileSync('git', ['config', 'user.email', 'fixture@test.local'], gitOpts);
  execFileSync('git', ['config', 'user.name', 'Fixture Test'], gitOpts);
  execFileSync('git', ['add', '.'], gitOpts);
  execFileSync('git', ['commit', '-m', 'baseline S0'], gitOpts);

  return {
    baselineTestHash: createHash('sha256').update(testContent).digest('hex'),
    baselinePackageHash: createHash('sha256').update(pkgContent).digest('hex'),
    baselineHead: execFileSync('git',['rev-parse','HEAD'],{...gitOpts,encoding:'utf8'}).trim(),
    baselineIndex: execFileSync('git',['ls-files','--stage','-z'],{...gitOpts,encoding:'utf8'}),
  };
}

const runtimeBlobCache = new Map();

/**
 * Extracts immutable Git-tracked source and package.json from accepted commit SHA.
 */
export function extractRuntime(repoDir, runtimeDir, runtimeRef = ACCEPTED_RUNTIME_SHA) {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(runtimeRef)) {
    throw new Error(`Invalid runtime ref: must be full 40 or 64 hex SHA, got '${runtimeRef}'`);
  }
  const resolvedRuntimeDir = path.resolve(runtimeDir);
  mkdirSync(resolvedRuntimeDir, { recursive: true });
  const gitOptions = {
    cwd: repoDir,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    maxBuffer: 16 * 1024 * 1024,
  };
  const runtimeCommit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${runtimeRef}^{commit}`], gitOptions)
    .toString('utf8')
    .trim();
  if (runtimeCommit.toLowerCase() !== ACCEPTED_RUNTIME_SHA.toLowerCase()) {
    throw new Error(`Runtime commit '${runtimeCommit}' is not the accepted SHA '${ACCEPTED_RUNTIME_SHA}'`);
  }
  const runtimeTree = execFileSync('git', ['ls-tree', '-rz', runtimeCommit, '--', 'src', 'package.json'], gitOptions)
    .toString('utf8');

  let runtimeFiles = 0;
  for (const entry of runtimeTree.split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]+)\t(.+)$/s.exec(entry);
    if (!match) throw new Error('Stable runtime requires regular Git-tracked source files.');
    const [, , oid, filename] = match;
    const target = path.resolve(resolvedRuntimeDir, filename);
    if (!target.startsWith(resolvedRuntimeDir + path.sep) || (filename !== 'package.json' && !filename.startsWith('src/'))) {
      throw new Error('Invalid stable runtime path.');
    }
    mkdirSync(path.dirname(target), { recursive: true });
    let content = runtimeBlobCache.get(oid);
    if (!content) {
      let attempts = 0;
      while (attempts < 3) {
        try {
          content = execFileSync('git', ['cat-file', 'blob', oid], gitOptions);
          break;
        } catch (err) {
          attempts++;
          if (attempts >= 3) throw err;
        }
      }
      runtimeBlobCache.set(oid, content);
    }
    writeFileSync(target, content);
    runtimeFiles++;
  }
  if (!runtimeFiles || !runtimeTree.includes('\tpackage.json\0')) {
    throw new Error('Stable runtime is incomplete.');
  }
  return { runtimeCommit, runtimeFiles };
}

/**
 * Independent coordinator-owned offline checks running node/git on the fixture repo.
 */
export function runOfflineChecks(fixtureDir, opts = {}) {
  const { stage = 'S2', baselineHashes = null } = opts;
  const results = [];

  const scrubbedEnv = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    NODE_ENV: 'test',
    GIT_OPTIONAL_LOCKS: '0',
  };

  // 1. Baseline integrity checks: tests and package.json must remain untouched
  if (baselineHashes) {
    try {
      const currentTest = readFileSync(path.join(fixtureDir, 'tests/math.test.js'), 'utf8');
      const testHash = createHash('sha256').update(currentTest).digest('hex');
      const testMatch = testHash === baselineHashes.baselineTestHash;
      results.push({
        name: 'baseline_test_untouched',
        ok: testMatch,
        output: testMatch ? 'tests/math.test.js hash matched baseline' : 'tests/math.test.js was modified!',
      });
    } catch (err) {
      results.push({ name: 'baseline_test_untouched', ok: false, error: String(err) });
    }

    try {
      const currentPkg = readFileSync(path.join(fixtureDir, 'package.json'), 'utf8');
      const pkgHash = createHash('sha256').update(currentPkg).digest('hex');
      const pkgMatch = pkgHash === baselineHashes.baselinePackageHash;
      results.push({
        name: 'baseline_package_untouched',
        ok: pkgMatch,
        output: pkgMatch ? 'package.json hash matched baseline' : 'package.json was modified!',
      });
    } catch (err) {
      results.push({ name: 'baseline_package_untouched', ok: false, error: String(err) });
    }
  }

  if (baselineHashes) {
    try {
      const options={cwd:fixtureDir,windowsHide:true,encoding:'utf8',env:scrubbedEnv,timeout:10000,maxBuffer:65536};
      const head=execFileSync('git',['rev-parse','HEAD'],options).trim();
      const index=execFileSync('git',['ls-files','--stage','-z'],options);
      results.push({name:'baseline_git_unchanged',ok:head===baselineHashes.baselineHead && index===baselineHashes.baselineIndex,output:'Coordinator compared original HEAD and semantic Git index'});
    } catch { results.push({name:'baseline_git_unchanged',ok:false,error:'Original Git baseline unavailable'}); }
  }

  // 2. Working tree file checks: only 3 allowed source files (math.js, calc.js, obsolete.js)
  try {
    const gitStatus = execFileSync('git', ['status', '--porcelain'], {
      cwd: fixtureDir,
      windowsHide: true,
      encoding: 'utf8',
      env: scrubbedEnv,
      timeout: 10000,
      maxBuffer: 64 * 1024,
    });
    const lines = gitStatus.split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean);
    const allowedPaths = ['src/math.js', 'src/calc.js', 'src/obsolete.js'];
    const invalidEdits = lines.filter(l => {
      const match = /^[ MADRCU?!]{1,2}\s+(.+)$/.exec(l);
      const filePath = (match ? match[1] : l.slice(2).trim()).replace(/\\/g, '/');
      return !allowedPaths.includes(filePath);
    });
    const valid = invalidEdits.length === 0;
    results.push({
      name: 'working_tree_allowed_edits_only',
      ok: valid,
      output: valid ? `Only allowed files edited:\n${gitStatus.trim()}` : `Disallowed files edited: ${invalidEdits.join(', ')}`,
    });
  } catch (err) {
    results.push({ name: 'working_tree_allowed_edits_only', ok: false, error: String(err) });
  }

  // 3. Functional file checks: calc.js added, obsolete.js deleted
  try {
    const calcPath = path.join(fixtureDir, 'src/calc.js');
    const calcExists = existsSync(calcPath);
    const obsoletePath = path.join(fixtureDir, 'src/obsolete.js');
    const obsoleteDeleted = !existsSync(obsoletePath);
    const filesOk = calcExists && obsoleteDeleted;
    results.push({
      name: 'fixture_files_state',
      ok: filesOk,
      output: `calc.js exists: ${calcExists}, obsolete.js deleted: ${obsoleteDeleted}`,
    });
  } catch (err) {
    results.push({ name: 'fixture_files_state', ok: false, error: String(err) });
  }

  // Protected baseline failures stop before coordinator executes altered tests.
  if (results.some(result => !result.ok && result.name.startsWith("baseline_"))) return results;

  // 4. Test run check:
  // At stage S1: deliberate failure is EXPECTED!
  // At stage S2: node tests MUST pass!
  if (stage === 'S1') {
    try {
      execFileSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/math.test.js'], {
        cwd: fixtureDir,
        windowsHide: true,
        encoding: 'utf8',
        env: scrubbedEnv,
        timeout: 10000,
        maxBuffer: 64 * 1024,
      });
      // If it passed in S1, that's an error because the benign defect was not present!
      results.push({
        name: 's1_deliberate_test_failure',
        ok: false,
        error: 'Expected tests to fail in S1 due to deliberate divide defect, but tests passed.',
      });
    } catch (error) {
      const output = String(error.stdout ?? '');
      const expected = error.status === 1 && !error.signal && /not ok \d+ - divide/.test(output) && /# fail 1/.test(output);
      // Only the expected assertion failure counts as the deliberate defect.
      results.push({
        name: 's1_deliberate_test_failure',
        ok: expected,
        output: 'Deliberate test failure verified in S1 as expected.',
      });
    }
  } else {
    // S2 stage: tests MUST pass
    try {
      const nodeTest = execFileSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/math.test.js'], {
        cwd: fixtureDir,
        windowsHide: true,
        encoding: 'utf8',
        env: scrubbedEnv,
        timeout: 10000,
        maxBuffer: 64 * 1024,
      });
      results.push({
        name: 's2_node_test_passed',
        ok: true,
        output: nodeTest.trim(),
      });
    } catch (err) {
      results.push({
        name: 's2_node_test_passed',
        ok: false,
        error: String(err),
      });
    }
  }

  return results;
}

/**
 * Builds a privacy-safe public assessment summary without thinking markers or credentials.
 */
export function buildPrivacySafeAssessment(evidence) {
  return {
    schema_version: 1,
    name: evidence.name,
    status: evidence.status,
    started_at: evidence.startedAt,
    finished_at: evidence.finishedAt,
    provider: evidence.routes?.[0]?.provider ?? 'unknown',
    model: evidence.routes?.[0]?.model ?? 'unknown',
    turns_completed: evidence.turns ? evidence.turns.length : 0,
    snapshots: evidence.snapshots ?? { s0: null, s1: null, s2: null },
    artifact_chain: {
      findings_artifact_id: evidence.findings_artifact?.artifact_id ?? null,
      findings_size_bytes: evidence.findings_artifact?.size_bytes ?? null,
      findings_content_hash: evidence.findings_artifact?.content_hash ?? null,
      delivered_mode: evidence.findings_artifact?.delivery_mode ?? 'inline',
    },
    continuity: {
      worker_native_ref_retained: !!evidence.workerNativeRef,
      reviewer_native_ref_retained: !!evidence.reviewerNativeRef,
      same_worker_conversation: evidence.sameWorkerConversation ?? false,
      same_reviewer_conversation: evidence.sameReviewerConversation ?? false,
    },
    offline_checks: evidence.offline_checks?.map(c => ({ name: c.name, ok: c.ok })) ?? [],
    all_checks_passed: evidence.offline_checks?.every(c => c.ok) ?? false,
    limitations: [
      'Offline mock simulations do not represent native LLM benchmark performance',
      'Native CLI execution permissions remain subject to provider runtime boundaries',
      'Copied workspace trees do not guarantee complete native process sandboxing',
      'Turn input grants do not verify model comprehension or read receipts',
    ],
  };
}

/**
 * Validates provider configuration against operator constraints.
 */
export function validateRouteConfig(route, role = 'worker', isProduction = false) {
  if (!route) throw new Error(`Missing route configuration for ${role}.`);
  const provider = route.provider;
  if (!provider) throw new Error(`Provider must be specified for ${role}.`);

  if (FORBIDDEN_PROVIDERS.includes(provider)) {
    throw new Error(`Forbidden provider '${provider}': Claude and Codex routes are strictly disallowed.`);
  }
  if (!AUTHORIZED_PROVIDERS.includes(provider)) {
    throw new Error(`Unauthorized provider '${provider}'. Allowed: ${AUTHORIZED_PROVIDERS.join(', ')}.`);
  }
  if (provider === 'mock') {
    if (isProduction) {
      throw new Error(`Provider 'mock' is not allowed in production mode. Use --mock for offline mode.`);
    }
  } else {
    if (typeof route.model !== 'string' || !route.model.trim()) {
      throw new Error(`Production mode requires explicit model string for provider '${provider}'.`);
    }
    if (isProduction) {
      if (provider === 'zcode' && (typeof route.effort !== 'string' || !route.effort.trim())) {
        throw new Error(`Production mode requires explicit effort string for provider '${provider}'.`);
      }
    }
  }
}

/**
 * Validates strict production configuration requirements.
 */
export function validateProductionConfig(taskConfig) {
  const deadline=taskConfig.deadline_ms ?? 3600000;
  if (!Number.isInteger(deadline) || deadline < 1000 || deadline > 86400000) throw new Error("Invalid deadline_ms bound");
  if (taskConfig.mock) {
    if ((taskConfig.provider ?? 'mock') !== 'mock' || (taskConfig.reviewer_provider ?? taskConfig.provider ?? 'mock') !== 'mock') throw new Error("Mock mode forbids native provider routes");
    return;
  }

  if (taskConfig.root !== undefined) {
    throw new Error('Refusing custom root: production harness requires exclusive fresh root generated under approved base directory.');
  }

  const sha = taskConfig.runtime_sha ?? taskConfig.runtime_ref;
  if (!sha || typeof sha !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(sha)) {
    throw new Error('Production mode requires explicit full 40 or 64 hex accepted runtime SHA. Default HEAD or guesses disallowed.');
  }
  if (sha.toLowerCase() !== ACCEPTED_RUNTIME_SHA.toLowerCase()) {
    throw new Error(`Production runtime SHA '${sha}' does not match accepted SHA '${ACCEPTED_RUNTIME_SHA}'.`);
  }

  validateRouteConfig({
    provider: taskConfig.provider,
    model: taskConfig.model,
    effort: taskConfig.effort,
  }, 'worker', true);

  validateRouteConfig({
    provider: taskConfig.reviewer_provider ?? taskConfig.provider,
    model: taskConfig.reviewer_model ?? taskConfig.model,
    effort: taskConfig.reviewer_effort ?? taskConfig.effort,
  }, 'reviewer', true);


}

/**
 * Resolves and validates an exclusive owned harness root directory.
 */
export function resolveAndValidateHarnessRoot(taskConfig, baseRepoRoot) {
  const approvedBase = path.resolve(baseRepoRoot, '.state/native-feedback');
  assertNoLinkAncestors(approvedBase);
  mkdirSync(approvedBase, { recursive: true });

  if (lstatSync(approvedBase).isSymbolicLink()) {
    throw new Error(`Approved harness base directory '${approvedBase}' cannot be a symbolic link.`);
  }

  let root;
  if (taskConfig.root) {
    const candidate = path.resolve(taskConfig.root);
    if (existsSync(candidate)) {
      throw new Error(`Refusing preexisting root directory '${candidate}'. Fresh exclusive root required.`);
    }
    if (!candidate.startsWith(approvedBase + path.sep)) {
      throw new Error(`Refusing root '${candidate}': must be inside approved directory '${approvedBase}'.`);
    }
    let curr = candidate;
    while (curr && curr !== path.dirname(curr)) {
      if (existsSync(curr) && lstatSync(curr).isSymbolicLink()) {
        throw new Error(`Refusing root with symlink ancestor: '${curr}'`);
      }
      if (curr === approvedBase) break;
      curr = path.dirname(curr);
    }
    root = candidate;
  } else {
    const token = randomUUID().slice(0, 8);
    const dirName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${token}`;
    root = path.join(approvedBase, dirName);
  }

  assertNoLinkAncestors(root);
  mkdirSync(root);
  const ownerToken = randomUUID();
  writeFileSync(path.join(root, '.owner-marker.json'), JSON.stringify({
    harness: 'agent-broker-native-feedback',
    owner_token: ownerToken,
    pid: process.pid,
    created_at: Date.now(),
  }, null, 2));

  return { root, ownerToken, approvedBase };
}

/**
 * Validates that a directory is safe to clean up.
 */
export function validateExclusiveRootForCleanup(root, approvedBase, ownerToken) {
  assertNoLinkAncestors(root);
  const resolvedRoot = path.resolve(root);
  const resolvedBase = path.resolve(approvedBase);

  if (resolvedRoot === resolvedBase) {
    throw new Error('Refusing cleanup: root cannot be the approved base directory itself.');
  }
  if (!resolvedRoot.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Refusing cleanup: root '${resolvedRoot}' is not contained within approved base '${resolvedBase}'.`);
  }

  let curr = resolvedRoot;
  while (curr && curr !== path.dirname(curr)) {
    if (existsSync(curr) && lstatSync(curr).isSymbolicLink()) {
      throw new Error(`Refusing cleanup: path component '${curr}' is a symbolic link.`);
    }
    if (curr === resolvedBase) break;
    curr = path.dirname(curr);
  }

  const markerPath = path.join(resolvedRoot, '.owner-marker.json');
  if (!existsSync(markerPath)) {
    throw new Error(`Refusing cleanup: missing owner marker in '${resolvedRoot}'.`);
  }
  const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
  if (marker.harness !== 'agent-broker-native-feedback' || marker.owner_token !== ownerToken) {
    throw new Error(`Refusing cleanup: invalid owner marker in '${resolvedRoot}'.`);
  }
}

/**
 * Determines whether cleanup is permissible.
 */
export function canPerformCleanup(evidence, task) {
  if (!task.cleanup) return false;
  if (evidence.status !== 'passed') return false;
  if (!evidence.turns || evidence.turns.length === 0) return false;
  for (const t of evidence.turns) {
    if (t.status?.state !== 'SUCCEEDED') return false;
  }
  if (!evidence.sessionsClosed || evidence.closeError || evidence.unresolvedChildren) return false;
  if (!evidence.daemonCompleted || !evidence.bridgeCompleted) return false;
  if (!evidence.offline_checks || !evidence.offline_checks.every(c => c.ok)) return false;
  return true;
}

/**
 * Reads all pages of a textual artifact via public agent_artifact_read DTO.
 */
export async function readFullArtifact(tool, artifactId, maxBytesLimit = DEFAULT_MAX_REPORT_BYTES) {
  if (!Number.isSafeInteger(maxBytesLimit) || maxBytesLimit < 1 || maxBytesLimit > DEFAULT_MAX_REPORT_BYTES) throw new Error('Invalid artifact byte bound');
  const chunks = [];
  let offset = 0;
  let meta = null;
  do {
    const page = await tool('agent_artifact_read', { artifact_id: artifactId, offset, max_bytes: Math.min(65536, maxBytesLimit) });
    if (page.artifact_id !== artifactId || page.content_type !== 'text' || !Number.isSafeInteger(page.size_bytes) || page.size_bytes < 0 || page.size_bytes > maxBytesLimit || page.offset !== offset || typeof page.data !== 'string') throw new Error('Invalid textual artifact page identity or bound');
    if (meta && (page.size_bytes !== meta.size_bytes || page.kind !== meta.kind || page.state !== meta.state)) throw new Error('Artifact metadata changed between pages');
    meta ??= {api_version:page.api_version,artifact_id:page.artifact_id,kind:page.kind,state:page.state,size_bytes:page.size_bytes,content_type:page.content_type};
    const bytes = Buffer.from(page.data, 'utf8');
    if (page.bytes_read !== bytes.length || page.next_offset !== offset + bytes.length || page.next_offset > page.size_bytes || page.truncated !== (page.next_offset < page.size_bytes)) throw new Error('Artifact byte paging inconsistent');
    chunks.push(bytes);
    offset = page.next_offset;
    if (!page.truncated) break;
    if (bytes.length === 0) throw new Error('Artifact paging made no progress');
  } while (offset < maxBytesLimit);
  if (offset !== meta.size_bytes) throw new Error('Artifact delivery incomplete');
  const full = Buffer.concat(chunks);
  const text = full.toString('utf8');
  if (/<\/?(?:thinking|analysis)\b|chain[ -]of[ -]thought/i.test(text)) throw new Error('Declared report withheld: reasoning marker');
  return {meta, size_bytes:full.length, content_hash:createHash('sha256').update(full).digest('hex'), text};
}

/**
 * Sanitizes event items to typed public metadata only.
 */
function sanitizePublicEvent(ev) {
  return {
    cursor: ev.cursor,
    type: ev.type,
    created_at: ev.created_at,
    payload: ev.payload ? {
      ...(ev.payload.label ? { label: String(ev.payload.label) } : {}),
      ...(ev.payload.ref ? { ref: String(ev.payload.ref) } : {}),
      ...(ev.payload.name ? { name: String(ev.payload.name) } : {}),
      ...(ev.payload.toolkind ? { toolkind: String(ev.payload.toolkind) } : {}),
      ...(ev.payload.status ? { status: String(ev.payload.status) } : {}),
      ...(ev.payload.decision ? { decision: String(ev.payload.decision) } : {}),
    } : null,
  };
}

/**
 * Main execution harness for normative worker -> review -> fix -> same-reviewer flow.
 */
export async function runNativeFeedback(taskConfig = {}) {
  const task = { ...taskConfig };
  task.name = task.name ?? `feedback-run-${Date.now()}`;
  task.provider = task.provider ?? (task.mock ? 'mock' : 'mock');
  task.model = task.model ?? (task.provider === 'mock' ? 'mock-model' : undefined);
  task.reviewer_provider = task.reviewer_provider ?? task.provider;
  task.reviewer_model = task.reviewer_model ?? task.model;
  task.deadline_ms = task.deadline_ms ?? 3600000;
  task.reviewer_effort ??= task.effort;

  // Strict config validation
  validateProductionConfig(task);
  validateRouteConfig({ provider: task.provider, model: task.model, effort: task.effort }, 'worker', !task.mock);
  validateRouteConfig({ provider: task.reviewer_provider, model: task.reviewer_model, effort: task.reviewer_effort }, 'reviewer', !task.mock);

  const { root, ownerToken, approvedBase } = resolveAndValidateHarnessRoot(task, repoRoot);
  const runtime = path.join(root, 'runtime');
  const state = path.join(root, 'state');
  const fixtureRepo = path.join(root, 'fixture-repo');
  const reportsDir = path.join(root, 'reports');

  mkdirSync(state, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });

  // 1. Immutable broker runtime extraction from accepted git commit SHA
  const runtimeRef = task.runtime_sha ?? task.runtime_ref ?? ACCEPTED_RUNTIME_SHA;
  const { runtimeCommit, runtimeFiles } = extractRuntime(repoRoot, runtime, runtimeRef);

  // 2. Initialize owned harmless temporary fixture Git repository
  const baselineHashes = createFixtureGitRepo(fixtureRepo);

  // 3. Seed SQLite registry with coverage, policies, workspaces
  const { openRegistryDb } = await import(pathToFileURL(path.join(runtime, 'src/storage/db.ts')).href);
  const registry = await import(pathToFileURL(path.join(runtime, 'src/storage/repo.ts')).href);
  const { coverageContractHash } = await import(pathToFileURL(path.join(runtime, 'src/workspaces/coverage.ts')).href);

  const db = openRegistryDb(path.join(state, 'registry.sqlite'));
  const coverage = {
    source_prefixes: ['src', 'tests', 'package.json'],
    non_source_prefixes: [],
    excluded_prefixes: ['.git', 'node_modules', '.state', 'dist'],
  };

  registry.insertProject(db, {
    project_id: 'self',
    display_name: 'Native Feedback Harness Project',
    configuration_revision: 1,
    session_cap: 8,
    created_at: Date.now(),
  });
  registry.insertCoordinator(db, {
    coordinator_id: 'self-coordinator',
    display_name: 'Native Feedback Client',
    allowed_project_ids: ['self'],
    revoked: false,
    config_revision: 1,
  });

  for (const p of AUTHORIZED_PROVIDERS) {
    registry.insertAccount(db, {
      account_profile_id: p,
      provider: p,
      quota_scope_id: `native:${p}`,
      auth_mode: 'cli-owned',
    });
  }

  registry.insertCoverageProfile(db, {
    coverage_profile_id: 'source',
    version: '1',
    config: JSON.stringify(coverage),
    contract_hash: coverageContractHash(coverage),
  });

  registry.insertPolicyProfile(db, {
    policy_profile_id: 'worker',
    version: '1',
    config: JSON.stringify({ access: 'workspace_write', write_scope: task.write_scope ?? ['src/math.js','src/calc.js','src/obsolete.js'] }),
  });
  registry.insertPolicyProfile(db, {
    policy_profile_id: 'reviewer',
    version: '1',
    config: JSON.stringify({ access: 'read_only', write_scope: [] }),
  });

  registry.insertWorkspace(db, {
    workspace_id: 'fixture',
    project_id: 'self',
    mode: 'current',
    canonical_path: fixtureRepo,
    quarantined: false,
    quarantine_reason: null,
    coverage_profile_id: 'source',
  });
  registry.insertWorkspace(db, {
    workspace_id: 'review',
    project_id: 'self',
    mode: 'review_slot',
    canonical_path: null,
    quarantined: false,
    quarantine_reason: null,
    coverage_profile_id: 'source',
  });

  registry.insertCoordinator(db, {coordinator_id:'outsider',display_name:'Foreign ACL test',allowed_project_ids:[],revoked:false,config_revision:1});
  db.close();

  // Environment setup: strip Claude and Codex credentials and binaries
  const env = {
    ...process.env,
    AB_STATE_DIR: state,
    AB_COORDINATOR_ID: 'self-coordinator',
    AB_ROLE: 'daemon',
    NODE_PATH: path.join(repoRoot, 'node_modules'),
    AB_ZCODE_BUNDLE: path.join(process.env.LOCALAPPDATA ?? '', 'Programs/ZCode/resources/glm/zcode.cjs'),
    AB_ANTIGRAVITY_BIN: path.join(process.env.LOCALAPPDATA ?? '', 'agy/bin/agy.exe'),
    AB_CURSOR_BIN: path.join(process.env.LOCALAPPDATA ?? '', 'cursor-agent/cursor-agent.ps1'),
  };
  delete env.AB_CLAUDE_BIN;
  delete env.AB_CODEX_BIN;
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;

  if (task.provider === 'mock') {
    env.AB_MOCK_FEEDBACK = '1';
    if (task.large_findings) env.AB_MOCK_LARGE_FINDINGS = '1';
    if (task.test_active_disconnect) env.AB_MOCK_ACTIVE_DISCONNECT = '1';
    if (task.mock_fault) env.AB_MOCK_FAULT = task.mock_fault;
  } else {
    delete env.AB_MOCK_FEEDBACK;
    delete env.AB_MOCK_LARGE_FINDINGS;
    delete env.AB_MOCK_FAULT;
    delete env.AB_MOCK_ACTIVE_DISCONNECT;
  }

  // Spawn daemon
  let daemon = spawn(
    process.execPath,
    ['--experimental-transform-types', fileURLToPath(import.meta.url), '--serve', runtime],
    { cwd: runtime, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  );
  let daemonClosed = once(daemon, 'close').then(() => true, () => false);
  let daemonLog = '';
  daemon.stderr.on('data', chunk => { daemonLog = logTail(daemonLog, chunk); });

  let bridge = null;
  let bridgeClosed = null;
  let bridgeLog = '';
  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  const sessions = [];

  const evidence = {
    name: task.name,
    runtime,
    runtimeCommit,
    runtimeFiles,
    fixtureRepo,
    startedAt: new Date().toISOString(),
    status: 'running',
    turns: [],
    snapshots: { s0: null, s1: null, s2: null },
    findings_artifact: null,
    source_read_receipts: 'unknown',
    routes: [
      { role: 'worker', provider: task.provider, model: task.model, effort: task.effort },
      { role: 'reviewer', provider: task.reviewer_provider, model: task.reviewer_model, effort: task.reviewer_effort },
    ],
  };

  const saveEvidence = () => {
    writeFileSync(path.join(root, 'evidence.private.json'), JSON.stringify(evidence, null, 2));
    const assessment = buildPrivacySafeAssessment(evidence);
    writeFileSync(path.join(root, 'assessment.json'), JSON.stringify(assessment, null, 2));
  };

  const clearAllPendingRpc = (errMessage) => {
    for (const [id, req] of pending.entries()) {
      clearTimeout(req.timer);
      req.reject(new Error(errMessage ?? 'RPC aborted'));
    }
    pending.clear();
  };

  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    if (!bridge || bridge.exitCode !== null) {
      return reject(new Error(`Bridge is not running (called ${method})`));
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC timeout: ${method}`));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  const tool = async (name, args = {}) => {
    const result = await rpc('tools/call', { name, arguments: args });
    const payload = JSON.parse(result.content[0].text);
    if (result.isError || payload.ok === false) {
      const code=typeof payload.error?.code==='string' && /^[A-Z_]{1,64}$/.test(payload.error.code) ? payload.error.code : 'RPC_REJECTED';
      throw new Error(`${name} failed: ${code}`);
    }
    return payload;
  };

  const connectBridge = async (coordinatorId = 'self-coordinator') => {
    if (bridge && !await boundedClose(bridge, bridgeClosed)) throw new Error('Bridge close unresolved');
    clearAllPendingRpc('Bridge reconnected');
    buffer = '';
    bridgeLog = '';
    bridge = spawn(
      process.execPath,
      ['--experimental-transform-types', 'src/bridge/main-stdio.ts'],
      { cwd: runtime, env:{...env,AB_COORDINATOR_ID:coordinatorId}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
    );
    bridgeClosed = once(bridge, 'close').then(() => true, () => false);
    bridge.stdin.on('error', () => clearAllPendingRpc('Bridge input closed'));
    bridge.stderr.on('data', chunk => { bridgeLog = logTail(bridgeLog, chunk); });
    bridge.stdout.setEncoding('utf8');
    bridge.stdout.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RPC_BYTES) { clearAllPendingRpc('RPC output limit'); bridge.stdin.end(); return; }
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { clearAllPendingRpc('Malformed RPC frame'); bridge.stdin.end(); return; }
        const request = pending.get(message.id);
        if (request) {
          clearTimeout(request.timer);
          pending.delete(message.id);
          message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result);
        }
      }
    });
    bridge.once('close', () => {
      clearAllPendingRpc(`Bridge closed: ${bridgeLog}`);
    });
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'native-feedback-client', version: '1' },
    });
    bridge.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  };

  try {
    // Wait for daemon ready
    const readyUntil = Date.now() + 20000;
    while (!daemonLog.includes('daemon listening')) {
      if (daemon.exitCode !== null || Date.now() > readyUntil) {
        throw new Error(`Daemon startup failed: ${daemonLog}`);
      }
      await new Promise(r => setTimeout(r, 100));
    }

    await connectBridge();

    // ──────────────────────────────────────────────────────────────────────────
    // TURN 1: Worker Turn (Baseline S0 -> S1)
    // ──────────────────────────────────────────────────────────────────────────
    const workerSpawn = await tool('agent_session_spawn', {
      project_id: 'self',
      idempotency_key: randomUUID(),
      provider: task.provider,
      account_profile_id: task.provider,
      model: task.model,
      ...(task.effort ? { effort: task.effort } : {}),
      role: 'worker',
      instructions:
        'Implement the assigned bounded package in the fixture repository. Allowed edits ONLY: src/math.js, src/calc.js, src/obsolete.js. Delete src/obsolete.js, add src/calc.js with a helper, and introduce a benign defect in src/math.js divide function. Run node --test tests/math.test.js. Final report MUST fit 3000 characters: changed files, behavior, exact check results and limitations.',
      workspace: { mode: 'current', workspace_id: 'fixture' },
      policy_profile_id: 'worker',
    });
    sessions.push(workerSpawn.session_id);
    const s0 = workerSpawn.initial_snapshot_id;
    if (!s0) throw new Error('Worker session missing initial baseline snapshot S0.');
    evidence.snapshots.s0 = s0;

    const workerDeadline = task.deadline_ms;
    const t1Send = await tool('agent_session_send', {
      session_id: workerSpawn.session_id,
      idempotency_key: randomUUID(),
      task: {
        goal: 'Add src/calc.js, remove src/obsolete.js, and introduce benign testable defect in divide function of src/math.js.',
        acceptance_criteria: ['src/calc.js added', 'src/obsolete.js removed', 'benign defect in divide'],
        artifact_refs: [],
        checks: ['git status', 'node --test tests/math.test.js'],
      },
      workspace_precondition: { expected_snapshot_id: s0 },
      deadline_ms: workerDeadline,
    });

    const t1Record = { role: 'worker', turnIndex: 1, turn_id: t1Send.turn_id, session_id: workerSpawn.session_id, status: null };
    evidence.turns.push(t1Record);
    saveEvidence();

    // Graceful Disconnect / Reconnect during ACTIVE turn test step
    if (task.test_active_disconnect) {
      let activeWaitUntil = Date.now() + 10000;
      let activeObserved = false;
      let eventsBefore;
      while (Date.now() < activeWaitUntil) {
        const curStatus = await tool('agent_turn_status', { turn_id: t1Send.turn_id });
        if (curStatus.state === 'RUNNING') { activeObserved = true; eventsBefore = await tool('agent_turn_events', { turn_id: t1Send.turn_id }); break; }
        await new Promise(r => setTimeout(r, 50));
      }
      assert(activeObserved, 'Turn never observed RUNNING before disconnect');
      // Bridge disconnects while turn is actively RUNNING
      if (!await boundedClose(bridge, bridgeClosed)) throw new Error('Bridge disconnect unresolved');

      // Bridge reconnects
      await connectBridge();
      const reconnectedStatus = await tool('agent_turn_status', { turn_id: t1Send.turn_id });
      assert(['RUNNING', 'SUCCEEDED', 'FINALIZING'].includes(reconnectedStatus.state));
      const reconnectedEvents = await tool('agent_turn_events', { turn_id: t1Send.turn_id });
      assert(reconnectedEvents.events?.length > 0, 'Events preserved after bridge reconnect.');
      assert.deepEqual(reconnectedEvents.events.slice(0, eventsBefore.events.length).map(e => e.cursor), eventsBefore.events.map(e => e.cursor), 'Event history prefix changed');
      evidence.active_disconnect_verified = true;
    }

    const t1Until = Date.now() + workerDeadline + 60000;
    while (true) {
      t1Record.status = await tool('agent_turn_status', { turn_id: t1Send.turn_id });
      if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'UNKNOWN', 'ABANDONED'].includes(t1Record.status.state)) break;
      if (Date.now() > t1Until) {
        await tool('agent_turn_cancel', { turn_id: t1Send.turn_id, idempotency_key: randomUUID() });
        throw new Error('Worker turn 1 timed out; cancellation requested.');
      }
      await new Promise(r => setTimeout(r, 200));
    }

    if (t1Record.status.state === 'UNKNOWN') {
      evidence.status = 'unknown';
      throw new Error(`Worker turn 1 entered UNKNOWN state.`);
    }

    t1Record.result = await tool('agent_turn_result', { turn_id: t1Send.turn_id });
    const workerSessionStatus1 = await tool('agent_session_status', { session_id: workerSpawn.session_id });
    const rawT1Events = await tool('agent_turn_events', { turn_id: t1Send.turn_id });
    t1Record.events = rawT1Events.events?.map(sanitizePublicEvent) ?? [];
    evidence.workerNativeRef = workerSessionStatus1.native_conversation_ref;
    if (!evidence.workerNativeRef) {
      throw new Error('Worker turn 1 failed to acquire native conversation ID.');
    }
    assert.equal(t1Record.status.state, 'SUCCEEDED', 'Worker turn 1 did not succeed.');

    const s1 = t1Record.result.broker_observed?.final_snapshot_id;
    if (!s1 || s1 === s0) throw new Error(`Expected distinct sealed final snapshot S1; got ${s1}`);
    evidence.snapshots.s1 = s1;

    // Persist declared report for Turn 1
    if (t1Record.result.full_message_artifact_id) {
      const rep = await readFullArtifact(tool, t1Record.result.full_message_artifact_id, DEFAULT_MAX_REPORT_BYTES);
      writeFileSync(path.join(reportsDir, 'turn-1-worker-report.txt'), rep.text);
    } else if (t1Record.result.agent_reported?.summary) {
      writeFileSync(path.join(reportsDir, 'turn-1-worker-report.txt'), t1Record.result.agent_reported.summary);
    }

    // Verify deliberate expected test failure at Stage S1
    const s1Checks = runOfflineChecks(fixtureRepo, { stage: 'S1', baselineHashes });
    evidence.s1_deliberate_failure_verified = s1Checks.some(c => c.name === 's1_deliberate_test_failure' && c.ok);
    if (!evidence.s1_deliberate_failure_verified) {
      throw new Error('S1 expected deliberate test failure was not observed.');
    }
    saveEvidence();

    // ──────────────────────────────────────────────────────────────────────────
    // TURN 2: Reviewer Turn (R1 Review of S0 -> S1 diff in sealed review slot)
    // ──────────────────────────────────────────────────────────────────────────
    const reviewerSpawn = await tool('agent_session_spawn', {
      project_id: 'self',
      idempotency_key: randomUUID(),
      provider: task.reviewer_provider,
      account_profile_id: task.reviewer_provider,
      model: task.reviewer_model,
      ...(task.reviewer_effort ? { effort: task.reviewer_effort } : {}),
      role: 'reviewer',
      instructions:
        'Independent read-only review. Read the required diff and source in this isolated target snapshot. Do not edit files, run mutating commands, invoke other agents/MCP, commit, or access credentials. Final report MUST fit 3000 characters: findings first, relative path/line, severity and reasoning; say if none found.',
      workspace: { mode: 'review_slot', workspace_id: 'review' },
      policy_profile_id: 'reviewer',
    });
    sessions.push(reviewerSpawn.session_id);

    const r1Deadline = task.deadline_ms;
    const r1Send = await tool('agent_session_send', {
      session_id: reviewerSpawn.session_id,
      idempotency_key: randomUUID(),
      task: {
        goal: 'Review fixture repository diff between S0 and S1 for defects and deleted/added files.',
        acceptance_criteria: ['report findings with file and line references'],
        artifact_refs: [],
      },
      review_binding: {
        baseline_snapshot_id: s0,
        target_snapshot_id: s1,
      },
      deadline_ms: r1Deadline,
    });

    const r1Record = { role: 'reviewer', turnIndex: 1, turn_id: r1Send.turn_id, session_id: reviewerSpawn.session_id, status: null };
    evidence.turns.push(r1Record);
    saveEvidence();

    const r1Until = Date.now() + r1Deadline + 60000;
    while (true) {
      r1Record.status = await tool('agent_turn_status', { turn_id: r1Send.turn_id });
      if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'UNKNOWN', 'ABANDONED'].includes(r1Record.status.state)) break;
      if (Date.now() > r1Until) {
        await tool('agent_turn_cancel', { turn_id: r1Send.turn_id, idempotency_key: randomUUID() });
        throw new Error('Reviewer turn 1 timed out; cancellation requested.');
      }
      await new Promise(r => setTimeout(r, 200));
    }

    if (r1Record.status.state === 'UNKNOWN') {
      evidence.status = 'unknown';
      throw new Error(`Reviewer turn 1 entered UNKNOWN state.`);
    }

    if (r1Record.status.state === 'FAILED') {
      r1Record.result = await tool('agent_turn_result', { turn_id: r1Send.turn_id });
      throw new Error(`Reviewer turn 1 failed: ${r1Record.result?.broker_observed?.error_code ?? 'FAILED'}. Review failure stops flow with explicit evidence.`);
    }

    r1Record.result = await tool('agent_turn_result', { turn_id: r1Send.turn_id });
    const reviewerSessionStatus1 = await tool('agent_session_status', { session_id: reviewerSpawn.session_id });
    const rawR1Events = await tool('agent_turn_events', { turn_id: r1Send.turn_id });
    r1Record.events = rawR1Events.events?.map(sanitizePublicEvent) ?? [];
    evidence.reviewerNativeRef = reviewerSessionStatus1.native_conversation_ref;
    if (!evidence.reviewerNativeRef) {
      throw new Error('Reviewer turn 1 failed to acquire native conversation ID.');
    }
    assert.equal(r1Record.status.state, 'SUCCEEDED', 'Reviewer turn 1 did not succeed; stops with explicit failed evidence.');

    // R1 reviewer findings must be sealed artifact
    const findingsArtifactId = r1Record.result.full_message_artifact_id;
    if (!findingsArtifactId) {
      throw new Error('R1 reviewer turn did not produce a sealed findings artifact.');
    }

    // Read complete findings artifact across all pages
    const findingsResult = await readFullArtifact(tool, findingsArtifactId, DEFAULT_MAX_REPORT_BYTES);
    let parsedFindings;
    try {
      parsedFindings = JSON.parse(findingsResult.text);
    } catch (e) {
      throw new Error(`Findings artifact ${findingsArtifactId} is not valid JSON: ${e}`);
    }

    if (parsedFindings.baseline_snapshot_id !== s0 || parsedFindings.target_snapshot_id !== s1) {
      throw new Error(`Findings snapshot binding mismatch: expected S0=${s0}, S1=${s1}; got S0=${parsedFindings.baseline_snapshot_id}, S1=${parsedFindings.target_snapshot_id}`);
    }
    if (!parsedFindings.text || typeof parsedFindings.text !== 'string' || !parsedFindings.text.trim()) {
      throw new Error(`Findings artifact ${findingsArtifactId} has empty or missing text.`);
    }
    if (!parsedFindings.text.includes('FINDING') || !parsedFindings.text.includes('src/math.js')) {
      throw new Error(`Findings artifact ${findingsArtifactId} has invalid or incomplete findings content.`);
    }

    // Persist full findings report artifact in reports/
    writeFileSync(path.join(reportsDir, 'turn-2-reviewer-findings.json'), findingsResult.text);

    evidence.findings_artifact = {
      artifact_id: findingsArtifactId,
      kind: 'findings',
      size_bytes: findingsResult.size_bytes,
      content_hash: findingsResult.content_hash,
      delivery_mode: 'inline', // Will be authoritatively verified in Turn 3 input manifest
    };
    saveEvidence();

    // ──────────────────────────────────────────────────────────────────────────
    // Optional Daemon Restart Scenario Verification
    // ──────────────────────────────────────────────────────────────────────────
    if (task.test_restart) {
      if (!await boundedClose(bridge, bridgeClosed)) throw new Error('Bridge disconnect unresolved');
      if (!await boundedClose(daemon, daemonClosed)) throw new Error('Daemon stop unresolved before restart');

      daemon = spawn(
        process.execPath,
        ['--experimental-transform-types', fileURLToPath(import.meta.url), '--serve', runtime],
        { cwd: runtime, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      );
      daemonClosed = once(daemon, 'close').then(() => true, () => false);
      daemonLog = '';
      daemon.stderr.on('data', chunk => { daemonLog = logTail(daemonLog, chunk); });

      const restartUntil = Date.now() + 20000;
      while (!daemonLog.includes('daemon listening')) {
        if (daemon.exitCode !== null || Date.now() > restartUntil) {
          throw new Error(`Daemon restart failed: ${daemonLog}`);
        }
        await new Promise(r => setTimeout(r, 100));
      }

      await connectBridge();

      const listResp = await tool('agent_sessions_list', { project_id: 'self' });
      const foundWorker = listResp.sessions?.find(s => s.session_id === workerSpawn.session_id);
      if (!foundWorker) {
        throw new Error(`Session ${workerSpawn.session_id} not found after daemon restart.`);
      }
      const recoveredWorker = await tool('agent_session_status', {session_id:workerSpawn.session_id});
      const recoveredReviewer = await tool('agent_session_status', {session_id:reviewerSpawn.session_id});
      assert.equal(recoveredWorker.native_conversation_ref, evidence.workerNativeRef);
      assert.equal(recoveredReviewer.native_conversation_ref, evidence.reviewerNativeRef);
      evidence.restart_metadata_recovered = true;
    }

    // Actual sealed R1 artifact over an actual foreign MCP bridge.
    await connectBridge('outsider');
    let denied = false;
    try { await tool('agent_artifact_read', {artifact_id:findingsArtifactId,offset:0,max_bytes:1}); }
    catch (error) { denied = /UNAUTHORIZED/.test(error.message); }
    assert(denied, 'Foreign coordinator must receive UNAUTHORIZED for actual findings ID');
    evidence.findings_acl_denial_verified = true;
    await connectBridge();

    // ──────────────────────────────────────────────────────────────────────────
    // TURN 3: Worker Fix Turn (SAME Worker Session, takes ONLY required artifactID)
    // ──────────────────────────────────────────────────────────────────────────
    const fixDeadline = task.deadline_ms;
    const fixSend = await tool('agent_session_send', {
      session_id: workerSpawn.session_id, // SAME worker session
      idempotency_key: randomUUID(),
      task: {
        goal: 'Address the defects identified in the findings artifact.',
        acceptance_criteria: ['defect in divide function resolved', 'tests pass'],
        // Must take ONLY required artifactID, NOT copied reviewer prose
        artifact_refs: [findingsArtifactId],
        checks: ['node --test tests/math.test.js'],
      },
      // Pinned to current target S1 baseline
      workspace_precondition: { expected_snapshot_id: s1 },
      deadline_ms: fixDeadline,
    });

    const fixRecord = { role: 'worker', turnIndex: 2, turn_id: fixSend.turn_id, session_id: workerSpawn.session_id, status: null };
    evidence.turns.push(fixRecord);
    saveEvidence();

    const fixUntil = Date.now() + fixDeadline + 60000;
    while (true) {
      fixRecord.status = await tool('agent_turn_status', { turn_id: fixSend.turn_id });
      if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'UNKNOWN', 'ABANDONED'].includes(fixRecord.status.state)) break;
      if (Date.now() > fixUntil) {
        await tool('agent_turn_cancel', { turn_id: fixSend.turn_id, idempotency_key: randomUUID() });
        throw new Error('Worker fix turn timed out; cancellation requested.');
      }
      await new Promise(r => setTimeout(r, 200));
    }

    if (fixRecord.status.state === 'UNKNOWN') {
      evidence.status = 'unknown';
      throw new Error(`Worker fix turn entered UNKNOWN state.`);
    }

    fixRecord.result = await tool('agent_turn_result', { turn_id: fixSend.turn_id });
    const workerSessionStatus2 = await tool('agent_session_status', { session_id: workerSpawn.session_id });
    const rawFixEvents = await tool('agent_turn_events', { turn_id: fixSend.turn_id });
    fixRecord.events = rawFixEvents.events?.map(sanitizePublicEvent) ?? [];

    // Assert same native conversation continuity
    const refObtainedEvent = rawFixEvents.events?.find(e => e.type === 'native_ref_obtained' || e.type === 'adapter:native_ref_obtained');
    const observedWorkerRef = refObtainedEvent?.payload?.ref ?? workerSessionStatus2.native_conversation_ref;
    if (observedWorkerRef !== evidence.workerNativeRef) {
      throw new Error(`Worker native conversation ref mismatch: expected ${evidence.workerNativeRef}, got ${observedWorkerRef}`);
    }
    evidence.sameWorkerConversation = true;
    assert.equal(fixRecord.status.state, 'SUCCEEDED', 'Worker fix turn did not succeed; stops with explicit failed evidence.');

    const s2 = fixRecord.result.broker_observed?.final_snapshot_id;
    if (!s2 || s2 === s1 || s2 === s0) throw new Error(`Expected distinct sealed final snapshot S2; got ${s2}`);
    evidence.snapshots.s2 = s2;

    // Verify FIX turn input manifest: exact findings ID, hash, size, and authoritative delivery grant
    const fixInputManifestId = fixRecord.result.broker_observed?.input_manifest_id;
    if (!fixInputManifestId) {
      throw new Error('Worker fix turn missing broker-observed input_manifest_id.');
    }
    const manifestResult = await readFullArtifact(tool, fixInputManifestId, DEFAULT_MAX_REPORT_BYTES);
    const manifest = JSON.parse(manifestResult.text);
    const findingsEntry = manifest.inputs?.find(i => i.artifact_id === findingsArtifactId);
    if (!findingsEntry) {
      throw new Error(`Input manifest ${fixInputManifestId} missing entry for required findings artifact ${findingsArtifactId}`);
    }

    assert.equal(findingsEntry.artifact_id, findingsArtifactId);
    assert.equal(findingsEntry.content_hash, evidence.findings_artifact.content_hash);
    assert.equal(findingsEntry.size_bytes, evidence.findings_artifact.size_bytes);

    // Authoritative delivery grant:
    evidence.findings_artifact.delivery_mode = findingsEntry.delivery;
    if (evidence.findings_artifact.size_bytes > INLINE_TOTAL_BYTE_CAP) {
      assert.equal(findingsEntry.delivery, 'read_only_path', 'Large findings must be granted read_only_path delivery');
      assert.equal(findingsEntry.access_enforcement, 'enforced');
      assert.equal(findingsEntry.lifetime, 'turn_until_quiescence');
    } else {
      assert.equal(findingsEntry.delivery, 'inline', 'Small findings must be delivered inline');
    }

    // Persist declared fix report
    if (fixRecord.result.full_message_artifact_id) {
      const rep = await readFullArtifact(tool, fixRecord.result.full_message_artifact_id, DEFAULT_MAX_REPORT_BYTES);
      writeFileSync(path.join(reportsDir, 'turn-3-worker-fix-report.txt'), rep.text);
    } else if (fixRecord.result.agent_reported?.summary) {
      writeFileSync(path.join(reportsDir, 'turn-3-worker-fix-report.txt'), fixRecord.result.agent_reported.summary);
    }
    saveEvidence();

    // ──────────────────────────────────────────────────────────────────────────
    // TURN 4: Reviewer Turn (R2 Review on SAME Reviewer Session rebound to S2)
    // ──────────────────────────────────────────────────────────────────────────
    const r2Deadline = task.deadline_ms;
    const r2Send = await tool('agent_session_send', {
      session_id: reviewerSpawn.session_id, // SAME reviewer session
      idempotency_key: randomUUID(),
      task: {
        goal: 'Review fixture repository diff between S1 and S2 to verify fix and ensure no remaining defects.',
        acceptance_criteria: ['verify defect resolved', 'confirm deleted files absent and new files readable'],
        artifact_refs: [],
      },
      review_binding: {
        baseline_snapshot_id: s1,
        target_snapshot_id: s2,
      },
      deadline_ms: r2Deadline,
    });

    const r2Record = { role: 'reviewer', turnIndex: 2, turn_id: r2Send.turn_id, session_id: reviewerSpawn.session_id, status: null };
    evidence.turns.push(r2Record);
    saveEvidence();

    const r2Until = Date.now() + r2Deadline + 60000;
    while (true) {
      r2Record.status = await tool('agent_turn_status', { turn_id: r2Send.turn_id });
      if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'UNKNOWN', 'ABANDONED'].includes(r2Record.status.state)) break;
      if (Date.now() > r2Until) {
        await tool('agent_turn_cancel', { turn_id: r2Send.turn_id, idempotency_key: randomUUID() });
        throw new Error('Reviewer turn 2 timed out; cancellation requested.');
      }
      await new Promise(r => setTimeout(r, 200));
    }

    if (r2Record.status.state === 'UNKNOWN') {
      evidence.status = 'unknown';
      throw new Error(`Reviewer turn 2 entered UNKNOWN state.`);
    }

    r2Record.result = await tool('agent_turn_result', { turn_id: r2Send.turn_id });
    const reviewerSessionStatus2 = await tool('agent_session_status', { session_id: reviewerSpawn.session_id });
    const rawR2Events = await tool('agent_turn_events', { turn_id: r2Send.turn_id });
    r2Record.events = rawR2Events.events?.map(sanitizePublicEvent) ?? [];

    // Assert same reviewer conversation continuity
    const reviewerRefEvent = rawR2Events.events?.find(e => e.type === 'native_ref_obtained' || e.type === 'adapter:native_ref_obtained');
    const observedReviewerRef = reviewerRefEvent?.payload?.ref ?? reviewerSessionStatus2.native_conversation_ref;
    if (observedReviewerRef !== evidence.reviewerNativeRef) {
      throw new Error(`Reviewer native conversation ref mismatch: expected ${evidence.reviewerNativeRef}, got ${observedReviewerRef}`);
    }
    // Coordinator observation of sealed tree; native tool-read proof stays unknown.
    assert(/^session-[a-z0-9]+$/.test(reviewerSpawn.session_id));
    const reviewRoot=path.join(state,'slots',reviewerSpawn.session_id);
    assertNoLinkAncestors(reviewRoot);
    assert(!existsSync(path.join(reviewRoot,'src','obsolete.js')), 'Deleted source remains in R2 slot');
    for (const filename of ['src/math.js','src/calc.js','tests/math.test.js','package.json']) {
      const slotFile=path.join(reviewRoot,filename);
      assertNoLinkAncestors(slotFile);
      assert(lstatSync(slotFile).isFile());
      assert(readFileSync(slotFile).equals(readFileSync(path.join(fixtureRepo,filename))), 'R2 slot differs from S2 source');
    }
    evidence.r2_slot_s2_verified = true;
    evidence.sameReviewerConversation = true;
    if (task.test_restart && evidence.restart_metadata_recovered && evidence.sameWorkerConversation) evidence.daemon_restart_verified = true;
    assert.equal(r2Record.status.state, 'SUCCEEDED', 'Reviewer turn 2 did not succeed; stops with explicit failed evidence.');

    // Persist declared reviewer report for Turn 4
    if (r2Record.result.full_message_artifact_id) {
      const rep = await readFullArtifact(tool, r2Record.result.full_message_artifact_id, DEFAULT_MAX_REPORT_BYTES);
      writeFileSync(path.join(reportsDir, 'turn-4-reviewer-report.txt'), rep.text);
    } else if (r2Record.result.agent_reported?.summary) {
      writeFileSync(path.join(reportsDir, 'turn-4-reviewer-report.txt'), r2Record.result.agent_reported.summary);
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Optional Cancellation Scenario Verification
    // ──────────────────────────────────────────────────────────────────────────
    if (task.cancellation_scenario) {
      const cancelSpawn = await tool('agent_session_spawn', {
        project_id: 'self',
        idempotency_key: randomUUID(),
        provider: task.provider,
        account_profile_id: task.provider,
        model: task.model,
        role: 'worker',
        instructions: 'Test cancellation scenario.',
        workspace: { mode: 'current', workspace_id: 'fixture' },
        policy_profile_id: 'worker',
      });
      sessions.push(cancelSpawn.session_id);
      const cancelSend = await tool('agent_session_send', {
        session_id: cancelSpawn.session_id,
        idempotency_key: randomUUID(),
        task: { goal: 'Will be cancelled.', artifact_refs: [] },
        workspace_precondition: { expected_snapshot_id: s2 },
        deadline_ms: 60000,
      });

      await tool('agent_turn_cancel', {
        turn_id: cancelSend.turn_id,
        idempotency_key: randomUUID(),
        reason: 'Cancellation scenario test',
      });

      // Request acceptance alone is not proof: wait for terminal outcome AND trusted quiescence receipt
      const cancelWaitUntil = Date.now() + 20000;
      let finalCancelStatus = null;
      while (Date.now() < cancelWaitUntil) {
        finalCancelStatus = await tool('agent_turn_status', { turn_id: cancelSend.turn_id });
        if (['CANCELLED', 'FAILED', 'SUCCEEDED'].includes(finalCancelStatus.state)) break;
        await new Promise(r => setTimeout(r, 100));
      }

      evidence.cancellation_status = finalCancelStatus?.state ?? 'unresolved';
      if (!finalCancelStatus || finalCancelStatus.state !== 'CANCELLED') {
        throw new Error(`Cancellation did not reach CANCELLED; got ${finalCancelStatus?.state}`);
      }

      // Terminal session metadata is separate from the owned native receipt.
      const cancelSessionStatus = await tool('agent_session_status', { session_id: cancelSpawn.session_id });
      if (cancelSessionStatus.state !== 'IDLE' || cancelSessionStatus.active_turn_id !== null) {
        throw new Error(`Cancellation session terminal metadata inconsistent: session state ${cancelSessionStatus.state}, active_turn ${cancelSessionStatus.active_turn_id}`);
      }

      evidence.cancellation_status = finalCancelStatus.state;
      const cancellationEvents = await tool('agent_turn_events', {turn_id:cancelSend.turn_id});
      const receipt = cancellationEvents.events?.find(e => /(?:^|:)owned_quiescence$/.test(e.type) && e.payload?.active === 0 && e.payload?.drained === true);
      evidence.cancellation_quiescence_verified = !!receipt;
      evidence.cancellation_mock_terminal_verified = task.mock && finalCancelStatus.state === 'CANCELLED';
      if (!task.mock && !receipt) throw new Error('Native cancellation quiescence receipt unavailable; retain evidence');
    }

    // ──────────────────────────────────────────────────────────────────────────
    // Coordinator-owned Offline Checks on Fixture Repo at Stage S2
    // ──────────────────────────────────────────────────────────────────────────
    evidence.offline_checks = runOfflineChecks(fixtureRepo, { stage: 'S2', baselineHashes });
    const checksPassed = evidence.offline_checks.every(c => c.ok);
    if (!checksPassed) {
      throw new Error('Independent offline fixture checks failed on S2.');
    }

    evidence.status = 'passed';
  } catch (err) {
    if (evidence.status !== 'unknown') {
      evidence.status = 'failed';
    }
    evidence.error = String(err);
    process.exitCode = 1;
    console.error(`Native feedback run failed: ${evidence.error}`);
  } finally {
    clearAllPendingRpc('Harness teardown');

    // Close each session to confirmed CLOSED/completed, not just accepted/pending.
    evidence.sessionsClosed = sessions.length === 0;
    if (bridge && bridge.exitCode === null && bridge.signalCode === null) {
      let allClosed = true;
      for (const session_id of sessions) {
        try {
          await tool('agent_session_stop', {session_id,idempotency_key:randomUUID()});
          const until = Date.now() + 5000;
          let status;
          do {
            status = await tool('agent_session_status', {session_id});
            if (status.state === 'CLOSED' && status.close_state === 'completed') break;
            await new Promise(r => setTimeout(r, 50));
          } while (Date.now() < until);
          if (status?.state !== 'CLOSED' || status.close_state !== 'completed') throw new Error('Session close unresolved');
        } catch {
          allClosed = false;
          evidence.closeError = 'Session close failed or unresolved';
        }
      }
      evidence.sessionsClosed = allClosed;
    }
    evidence.bridgeCompleted = await boundedClose(bridge, bridgeClosed);
    evidence.daemonCompleted = await boundedClose(daemon, daemonClosed);
    evidence.unresolvedChildren = !evidence.bridgeCompleted || !evidence.daemonCompleted;
    if (evidence.status === 'passed' && (!evidence.sessionsClosed || evidence.unresolvedChildren)) evidence.status = 'unknown';

    evidence.finishedAt = new Date().toISOString();
    saveEvidence();

    writeFileSync(path.join(root, 'daemon.stderr.private.txt'), daemonLog);
    writeFileSync(path.join(root, 'bridge.stderr.private.txt'), bridgeLog);

    // Cleanup policy: only own validated roots after confirmed quiescence; RETAIN UNKNOWN!
    if (canPerformCleanup(evidence, task)) {
      try {
        validateExclusiveRootForCleanup(root, approvedBase, ownerToken);
        // Remove only temporary fixture repo, runtime, and state dirs
        // Keep evidence.private.json, assessment.json, reports/, logs!
        rmSync(path.join(root, 'fixture-repo'), { recursive: true, force: true });
        rmSync(path.join(root, 'runtime'), { recursive: true, force: true });
        rmSync(path.join(root, 'state'), { recursive: true, force: true });
        console.log(`CLEANED fixture in ${root} (evidence preserved)`);
      } catch (cleanupErr) {
        console.warn(`Cleanup failed: ${cleanupErr}`);
      }
    } else {
      if (evidence.status === 'unknown') {
        console.log(`[UNKNOWN] Fixture retained on disk for offline analysis: ${fixtureRepo}`);
      } else {
        console.log(`EVIDENCE retained on disk: ${root}`);
      }
    }
  }

  return { status: evidence.status, evidence, root };
}

// CLI execution handling
if (process.argv[2] !== '--serve' && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = process.argv[2];
  if (arg === '--help' || arg === '-h') {
    console.log(`Usage:
  node --experimental-transform-types scripts/native-feedback.mjs [config.json]
  node --experimental-transform-types scripts/native-feedback.mjs --mock
  node --experimental-transform-types scripts/native-feedback.mjs --serve <runtime>
Options:
  --mock               Run offline deterministic mock run
  --large-findings     Test large findings (>16 KiB) read_only_path transport
  --test-disconnect    Test graceful bridge disconnect/reconnect
  --cancellation       Test optional cancellation scenario
  --test-restart       Restart daemon between R1 and FIX before continuation
  --cleanup            Clean up validated temporary root after quiescence
`);
    process.exit(0);
  }

  const cliConfig = {};
  if (process.argv.includes('--mock')) cliConfig.mock = true;
  if (process.argv.includes('--large-findings')) cliConfig.large_findings = true;
  if (process.argv.includes('--test-disconnect')) cliConfig.test_active_disconnect = true;
  if (process.argv.includes('--test-restart')) cliConfig.test_restart = true;
  if (process.argv.includes('--cancellation')) cliConfig.cancellation_scenario = true;
  if (process.argv.includes('--cleanup')) cliConfig.cleanup = true;

  if (arg && !arg.startsWith('--') && existsSync(arg)) {
    const fileConfig = JSON.parse(readFileSync(arg, 'utf8'));
    Object.assign(cliConfig, fileConfig);
  }

  await runNativeFeedback(cliConfig);
}
