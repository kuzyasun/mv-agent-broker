// Manual native authentication step. Not imported by tests or smoke probes.
// Starts ZCode's browser login or a small masked API-key setup console.
// Native ZCode owns credential persistence; keys never enter OS arguments.
// Login updates the shared native credential store. Desktop provider defaults
// are protected by using a separate personal provider configuration path.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const apiKeySetup = process.argv[2] === '--api-key';
if (process.argv.length > 3 || (process.argv[2] && !apiKeySetup)) {
  throw new Error('Usage: node tests/native-smoke/zcode-native-login.mjs [--api-key]');
}
if (apiKeySetup && (!process.stdin.isTTY || !process.stdout.isTTY)) {
  throw new Error('API-key setup needs an interactive console. Run this command in PowerShell.');
}
const root = path.resolve('.state/zcode-native-login');
mkdirSync(root, { recursive: true });
const bundle = process.env.AB_ZCODE_BUNDLE ?? path.join(process.env.LOCALAPPDATA, 'Programs/ZCode/resources/glm/zcode.cjs');
const builtin = path.resolve(path.dirname(bundle), '../config/provider/zcode-builtin.json');
const env = {
  ...process.env,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(root, 'provider_config.json'),
  ZCODE_LOG_DIR: path.join(root, 'log'),
};
if (apiKeySetup) {
  // Desktop's bundle has no @zcode/tui. Supply only its local login UI, using
  // the native command handler instead of copying the encrypted-store format.
  // This private TUI interface is verified against this bundle; fail closed
  // on upgrades rather than risk sending a key through a changed handler.
  const verifiedBundle = '31965ce1d5d4a808ef156784f67996de42ccab335591d2386a61ea8f6f506a54';
  if (createHash('sha256').update(readFileSync(bundle)).digest('hex') !== verifiedBundle) {
    throw new Error('API-key setup needs revalidation for this ZCode bundle. No credentials were changed.');
  }
  const loginUi = new URL('./zcode-api-key-console.mjs', import.meta.url).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier === '@zcode/tui'
        ? { url: loginUi, shortCircuit: true }
        : nextResolve(specifier, context);
    },
  });
  Object.assign(process.env, env);
  process.chdir(root);
  process.argv = [process.execPath, bundle, 'tui', '--mode', 'plan'];
  await import(pathToFileURL(bundle).href);
} else {
  const child = spawn(process.execPath, [bundle, 'login', '--no-browser'], {
    cwd: root, windowsHide: true, stdio: 'inherit', env,
  });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('close', (code) => { process.exitCode = code ?? 1; });
}
