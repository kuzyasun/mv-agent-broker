// Minimal replacement for the Desktop bundle's missing @zcode/tui. It only
// calls the verified local login handler, never loads a session or model UI.
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

export function readHiddenKey(input = process.stdin, output = process.stdout) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error('API-key setup needs an interactive console.');
  }
  return new Promise((resolve) => {
    let hidden = false;
    const muted = new Writable({
      write(chunk, encoding, done) {
        if (!hidden) output.write(chunk, encoding);
        done();
      },
    });
    const reader = createInterface({ input, output: muted, terminal: true, historySize: 0 });
    let answer = '';
    reader.once('close', () => {
      // This one-shot command needs no more terminal input.
      input.unref?.();
      output.write('\n');
      resolve(answer);
    });
    reader.once('SIGINT', () => reader.close());
    reader.question('Z.AI Coding Plan API key (hidden; Enter to save, Ctrl+C to cancel): ', (value) => {
      answer = value;
      reader.close();
    });
    hidden = true;
  });
}

export async function configureApiKey(submitPrompt, output, readKey = readHiddenKey) {
  let apiKey = (await readKey()).trim();
  if (!apiKey || /\s|[\x00-\x1f\x7f]/u.test(apiKey)) {
    output.write('Setup cancelled: enter one non-empty API key. No credentials were changed.\n');
    return 1;
  }
  try {
    const result = await submitPrompt(`/login zai-coding-plan-api-key ${apiKey}`, {
      abortSignal: new AbortController().signal,
    });
    if (result.loginRequired !== false || !result.response?.startsWith('Configured Z.AI Coding Plan.')) {
      throw new Error('Native setup did not confirm success.');
    }
    output.write('API key saved for Z.AI Individual Coding Plan. Broker verification is still required.\n');
    return 0;
  } catch {
    // Do not print native errors or responses that might contain the input.
    output.write('API-key setup failed. The native handler did not confirm a saved key.\n');
    return 1;
  } finally {
    apiKey = '';
  }
}

export async function runTui({ submitPrompt, stdout }) {
  return configureApiKey(submitPrompt, stdout);
}
