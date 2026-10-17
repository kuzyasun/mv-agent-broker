import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
// Manual helper is deliberately outside the broker build.
// @ts-expect-error Native smoke helpers are JavaScript.
import { configureApiKey, readHiddenKey } from '../native-smoke/zcode-api-key-console.mjs';

function output() {
  return { write: vi.fn() };
}

describe('ZCode manual API-key console', () => {
  it('submits only the native local setup command and prints fixed success text', async () => {
    const write = output();
    const submit = vi.fn().mockResolvedValue({ loginRequired: false, response: 'Configured Z.AI Coding Plan.\nModel: test' });
    expect(await configureApiKey(submit, write, async () => ' synthetic-test-key ')).toBe(0);
    expect(submit).toHaveBeenCalledExactlyOnceWith('/login zai-coding-plan-api-key synthetic-test-key', {
      abortSignal: expect.any(AbortSignal),
    });
    expect(write.write).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('API key saved'));
    expect(JSON.stringify(write.write.mock.calls)).not.toContain('synthetic-test-key');
  });

  it.each(['', '   ', 'two keys', 'test\n/login', 'test\x00key'])('rejects empty or malformed input without dispatch (%j)', async (key) => {
    const submit = vi.fn();
    expect(await configureApiKey(submit, output(), async () => key)).toBe(1);
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    { loginRequired: true, response: 'Configured Z.AI Coding Plan.' },
    { loginRequired: false, response: 'unexpected synthetic-test-key' },
  ])('does not mistake a native failure for a saved key', async (result) => {
    const write = output();
    expect(await configureApiKey(vi.fn().mockResolvedValue(result), write, async () => 'synthetic-test-key')).toBe(1);
    expect(JSON.stringify(write.write.mock.calls)).not.toContain('synthetic-test-key');
  });

  it('does not print a native exception containing the key', async () => {
    const write = output();
    const submit = vi.fn().mockRejectedValue(new Error('failure: synthetic-test-key'));
    expect(await configureApiKey(submit, write, async () => 'synthetic-test-key')).toBe(1);
    expect(JSON.stringify(write.write.mock.calls)).not.toContain('synthetic-test-key');
  });

  it('reads a terminal key without echoing it and restores terminal mode', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const out = Object.assign(new PassThrough(), { isTTY: true, columns: 160 });
    let visible = '';
    out.on('data', (chunk) => { visible += chunk.toString(); });
    const key = readHiddenKey(input, out);
    input.write('synthetic-test-key\r');
    expect(await key).toBe('synthetic-test-key');
    expect(visible).toContain('API key (hidden');
    expect(visible).not.toContain('synthetic-test-key');
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it('cancels on Ctrl+C without returning a partial key', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const out = Object.assign(new PassThrough(), { isTTY: true });
    const key = readHiddenKey(input, out);
    input.write('synthetic-partial\x03');
    expect(await key).toBe('');
    expect(input.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it('refuses non-interactive input', () => {
    expect(() => readHiddenKey(new PassThrough(), new PassThrough())).toThrow('interactive console');
  });
});
