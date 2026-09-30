// Manual native authentication step. Not imported by tests or smoke probes.
// Starts ZCode's browser login; the CLI owns all credential handling.
// Login updates the shared native credential store. Desktop provider defaults
// are protected by using a separate personal provider configuration path.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve('.state/zcode-native-login');
mkdirSync(root, { recursive: true });
const bundle = process.env.AB_ZCODE_BUNDLE ?? path.join(process.env.LOCALAPPDATA, 'Programs/ZCode/resources/glm/zcode.cjs');
const builtin = path.resolve(path.dirname(bundle), '../config/provider/zcode-builtin.json');
const child = spawn(process.execPath, [bundle, 'login', '--no-browser'], {
  cwd: root, windowsHide: true, stdio: 'inherit', env: {
    ...process.env,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path.join(root, 'provider_config.json'),
    ZCODE_LOG_DIR: path.join(root, 'log'),
  },
});
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('close', (code) => { process.exitCode = code ?? 1; });
