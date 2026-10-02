/** Fake native process tests for Antigravity adapter; no vendor CLI or quota use. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AntigravityAdapter } from "../../src/providers/antigravity/antigravityAdapter.ts";
import { BrokerError } from "../../src/shared/errors.ts";
import type { AdapterEvent, TurnExecutionRequest } from "../../src/runtime/adapter.ts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "broker-agy-test-"));
  roots.push(root);
  const script = path.join(root, "fake.cjs");
  const sentinel = path.join(root, "launched.txt");
  writeFileSync(
    script,
    `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(sentinel)}, 'started');
const args = process.argv.slice(2);
const pIdx = args.indexOf('-p');
const promptArg = pIdx >= 0 ? args[pIdx + 1] : '';
let promptFile = null;
let promptContent = promptArg;
if (promptArg.startsWith('Open and follow the instructions in ')) {
  promptFile = promptArg.slice('Open and follow the instructions in '.length).trim();
  if (fs.existsSync(promptFile)) {
    promptContent = fs.readFileSync(promptFile, 'utf8');
  }
}
const resume = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : null;
const convId = resume || 'agy-native-conv-1';
const inspection = {
  args,
  cwd: process.cwd(),
  profile: process.env.USERPROFILE,
  appData: process.env.APPDATA,
  localAppData: process.env.LOCALAPPDATA,
  leaked: process.env.BROKER_TEST_SECRET !== undefined,
  promptFile,
  promptContentLength: promptContent.length,
};

console.log(JSON.stringify({ event: 'conversation_id', conversation_id: convId }));

const firstLine = promptContent.split('\\n')[0].trim();
if (firstLine === 'hang') {
  setTimeout(() => {}, 30000);
} else if (firstLine === 'nonzero') {
  console.error('native agy failure');
  process.exitCode = 7;
} else if (firstLine === 'stream-error') {
  console.log(JSON.stringify({ event: 'result', result: { status: 'FAILED', response: null, error: 'agy failure' } }));
} else if (firstLine === 'quota') {
  console.log(JSON.stringify({ event: 'result', result: { status: 'FAILED', response: null, error: 'Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 54m59s.' } }));
} else if (firstLine === 'quota-long') {
  console.log(JSON.stringify({ event: 'result', result: { status: 'FAILED', response: null, error: 'Individual quota reached. ' + 'D'.repeat(600) } }));
} else if (firstLine === 'quota-response') {
  console.log(JSON.stringify({ event: 'result', result: { status: 'FAILED', response: 'Individual quota reached. Please upgrade your subscription to increase your limits.', error: null } }));
} else if (firstLine === 'success-quota-prose') {
  console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Individual quota reached. Please upgrade your subscription to increase your limits.', error: null } }));
} else {
  console.log(JSON.stringify({ event: 'step_update', step_update: { text_delta: 'progress update' } }));
  console.log(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: JSON.stringify(inspection), error: null } }));
}
`,
  );
  const binary = path.join(root, process.platform === "win32" ? "fake.ps1" : "fake-cli");
  if (process.platform === "win32") {
    const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    writeFileSync(binary, `& ${quote(process.execPath)} ${quote(script)} $args\nexit $LASTEXITCODE\n`);
  } else {
    writeFileSync(binary, `#!${process.execPath}\nimport(${JSON.stringify(script)});\n`);
    chmodSync(binary, 0o755);
  }
  return { root, sentinel, adapter: new AntigravityAdapter({ binary }) };
}

function request(overrides: Partial<TurnExecutionRequest> = {}): TurnExecutionRequest {
  return {
    turn_id: "t-agy",
    session_id: "s-broker",
    role: "worker",
    provider: "antigravity",
    account_profile_id: "local",
    requested_model: "gemini-3.8-flash",
    requested_effort: null,
    instructions_hash: "hash",
    native_conversation_ref: null,
    task_envelope: "test prompt",
    workspace_mode: "current",
    workspace_path: null,
    deadline_at: Date.now() + 60000,
    clock: { now: () => Date.now() },
    ...overrides,
  };
}

function gate() {
  let count = 0;
  return {
    acquireDispatchPermission: () => {
      count++;
    },
    cancellationRequested: () => null,
    count: () => count,
  };
}

describe("Antigravity adapter", () => {
  it("exposes adapter version 0.2.3", () => {
    const adapter = new AntigravityAdapter();
    expect(adapter.adapterVersion).toBe("0.2.3");
  });

  describe("effort mapping in argv", () => {
    it.each(["low", "medium", "high", "max"] as const)(
      "passes requested_effort %s through --effort in argv",
      async (effort) => {
        const f = fixture();
        const result = await f.adapter.executeTurn(
          request({ requested_effort: effort }),
          gate(),
          () => {},
        );
        const inspection = JSON.parse(result.agent_reported!.summary);
        const effortIdx = inspection.args.indexOf("--effort");
        expect(effortIdx).toBeGreaterThanOrEqual(0);
        expect(inspection.args[effortIdx + 1]).toBe(effort);
      },
    );

    it("does not pass --effort when requested_effort is null", async () => {
      const f = fixture();
      const result = await f.adapter.executeTurn(
        request({ requested_effort: null }),
        gate(),
        () => {},
      );
      const inspection = JSON.parse(result.agent_reported!.summary);
      expect(inspection.args).not.toContain("--effort");
    });
  });

  describe("validation zero gate / zero launch", () => {
    it.each([
      { requested_effort: "extreme" },
      { requested_effort: "invalid" },
      { requested_effort: "" },
      { requested_effort: "none" },
    ])("rejects invalid effort %j before gate without launching", async (overrides) => {
      const f = fixture();
      const g = gate();
      await expect(f.adapter.executeTurn(request(overrides), g, () => {})).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        executionStarted: false,
      });
      expect(g.count()).toBe(0);
      expect(existsSync(f.sentinel)).toBe(false);
    });

    it.each([
      { requested_model: "" },
      { requested_model: "   " },
    ])("rejects missing/blank model %j before gate without launching", async (overrides) => {
      const f = fixture();
      const g = gate();
      await expect(f.adapter.executeTurn(request(overrides), g, () => {})).rejects.toMatchObject({
        code: "MODEL_UNAVAILABLE",
        executionStarted: false,
      });
      expect(g.count()).toBe(0);
      expect(existsSync(f.sentinel)).toBe(false);
    });

    it.each([
      { native_conversation_ref: "" },
      { native_conversation_ref: "   " },
    ])("rejects blank resume id %j before gate without launching", async (overrides) => {
      const f = fixture();
      const g = gate();
      await expect(f.adapter.executeTurn(request(overrides), g, () => {})).rejects.toMatchObject({
        code: "SESSION_NOT_RESUMABLE",
        executionStarted: false,
      });
      expect(g.count()).toBe(0);
      expect(existsSync(f.sentinel)).toBe(false);
    });
  });

  describe("gate placement and prompt file lifecycle", () => {
    it("cleans up prompt file when gate denies dispatch permission", async () => {
      const f = fixture();
      vi.spyOn(os, "tmpdir").mockReturnValue(f.root);
      const largePrompt = "A".repeat(2500);
      const beforeDirs = new Set(
        readdirSync(os.tmpdir()).filter((n) => n.startsWith("agent-broker-agy-")),
      );
      let createdPromptDir: string | null = null;

      const denyingGate = {
        acquireDispatchPermission: () => {
          const currentDirs = readdirSync(os.tmpdir()).filter((n) =>
            n.startsWith("agent-broker-agy-"),
          );
          const diff = currentDirs.filter((d) => !beforeDirs.has(d));
          if (diff.length > 0) {
            createdPromptDir = path.join(os.tmpdir(), diff[0]);
            expect(existsSync(path.join(createdPromptDir, "prompt.txt"))).toBe(true);
          }
          throw new Error("gate denied dispatch");
        },
        cancellationRequested: () => null,
      };

      await expect(
        f.adapter.executeTurn(request({ task_envelope: largePrompt }), denyingGate, () => {}),
      ).rejects.toThrow("gate denied dispatch");

      expect(createdPromptDir).not.toBeNull();
      // Prompt directory was cleaned up even though gate rejected
      expect(existsSync(createdPromptDir!)).toBe(false);
      // Process was never launched
      expect(existsSync(f.sentinel)).toBe(false);
      expect(f.adapter.dispatchPermissionAcquired("t-agy")).toBe(false);
    });

    it("prepares prompt file for large prompts (>2000 chars) and cleans up on success", async () => {
      const f = fixture();
      const largePrompt = "Large task instruction: " + "X".repeat(2500);
      const result = await f.adapter.executeTurn(
        request({ task_envelope: largePrompt }),
        gate(),
        () => {},
      );
      const inspection = JSON.parse(result.agent_reported!.summary);
      expect(inspection.promptFile).toBeTruthy();
      expect(inspection.promptContentLength).toBe(largePrompt.length);
      // Cleaned up after execution
      expect(existsSync(inspection.promptFile)).toBe(false);
      expect(existsSync(path.dirname(inspection.promptFile))).toBe(false);
    });

    it("passes small prompts directly via -p without creating a prompt file", async () => {
      const f = fixture();
      const smallPrompt = "Short envelope text";
      const result = await f.adapter.executeTurn(
        request({ task_envelope: smallPrompt }),
        gate(),
        () => {},
      );
      const inspection = JSON.parse(result.agent_reported!.summary);
      expect(inspection.promptFile).toBeNull();
      const pIdx = inspection.args.indexOf("-p");
      expect(inspection.args[pIdx + 1]).toBe(smallPrompt);
    });

    it("cleans up prompt file after process error", async () => {
      const f = fixture();
      vi.spyOn(os, "tmpdir").mockReturnValue(f.root);
      const largePrompt = "nonzero\n" + "Z".repeat(2500);
      const beforeDirs = new Set(
        readdirSync(os.tmpdir()).filter((n) => n.startsWith("agent-broker-agy-")),
      );
      let observedDir: string | null = null;

      await expect(
        f.adapter.executeTurn(request({ task_envelope: largePrompt }), {
          acquireDispatchPermission: () => {
            const currentDirs = readdirSync(os.tmpdir()).filter((n) =>
              n.startsWith("agent-broker-agy-"),
            );
            const diff = currentDirs.filter((d) => !beforeDirs.has(d));
            if (diff.length > 0) observedDir = path.join(os.tmpdir(), diff[0]);
          },
          cancellationRequested: () => null,
        }, () => {}),
      ).rejects.toMatchObject({ code: "PROVIDER_PROTOCOL_ERROR", executionStarted: true });

      expect(observedDir).not.toBeNull();
      expect(existsSync(observedDir!)).toBe(false);
    });

    it("cleans up prompt file after cancellation", async () => {
      const f = fixture();
      vi.spyOn(os, "tmpdir").mockReturnValue(f.root);
      const largePrompt = "hang\n" + "W".repeat(2500);
      const beforeDirs = new Set(
        readdirSync(os.tmpdir()).filter((n) => n.startsWith("agent-broker-agy-")),
      );
      let observedDir: string | null = null;
      let cancelReason: string | null = null;

      await expect(
        f.adapter.executeTurn(request({ task_envelope: largePrompt }), {
          acquireDispatchPermission: () => {
            const currentDirs = readdirSync(os.tmpdir()).filter((n) =>
              n.startsWith("agent-broker-agy-"),
            );
            const diff = currentDirs.filter((d) => !beforeDirs.has(d));
            if (diff.length > 0) observedDir = path.join(os.tmpdir(), diff[0]);
          },
          cancellationRequested: () => cancelReason,
        }, (ev) => {
          if (ev.type === "native_ref_obtained") cancelReason = "operator cancel";
        }),
      ).rejects.toMatchObject({ code: "PROVIDER_PROTOCOL_ERROR", executionStarted: true });

      expect(observedDir).not.toBeNull();
      expect(existsSync(observedDir!)).toBe(false);
    });

    it("does not launch when cancelled before launch", async () => {
      const f = fixture();
      await expect(
        f.adapter.executeTurn(request(), {
          acquireDispatchPermission: () => {},
          cancellationRequested: () => "cancelled early",
        }, () => {}),
      ).rejects.toMatchObject({ code: "PROVIDER_PROTOCOL_ERROR", executionStarted: false });
      expect(existsSync(f.sentinel)).toBe(false);
    });
  });

  describe("identity emission, resume, and environment", () => {
    it("emits native identity and passes explicit resume ref", async () => {
      const f = fixture();
      const events: AdapterEvent[] = [];
      const result = await f.adapter.executeTurn(
        request({ native_conversation_ref: "agy-prior-session" }),
        gate(),
        (ev) => events.push(ev),
      );
      expect(result.native_conversation_ref).toBe("agy-prior-session");
      const inspection = JSON.parse(result.agent_reported!.summary);
      const convIdx = inspection.args.indexOf("--conversation");
      expect(convIdx).toBeGreaterThanOrEqual(0);
      expect(inspection.args[convIdx + 1]).toBe("agy-prior-session");
      expect(events.filter((ev) => ev.type === "native_ref_obtained")).toEqual([
        { type: "native_ref_obtained", payload: { ref: "agy-prior-session" } },
      ]);
    });

    it("passes native auth environment without leaking broker test secrets", async () => {
      const f = fixture();
      vi.stubEnv("BROKER_TEST_SECRET", "super-secret");
      const result = await f.adapter.executeTurn(request(), gate(), () => {});
      const inspection = JSON.parse(result.agent_reported!.summary);
      expect(inspection.leaked).toBe(false);
      if (process.platform === "win32") {
        expect(inspection.profile).toBe(process.env.USERPROFILE);
        expect(inspection.appData).toBe(process.env.APPDATA);
        expect(inspection.localAppData).toBe(process.env.LOCALAPPDATA);
      }
    });
  });

  describe("quota classification from explicit FAILED error", () => {
    it("maps the observed individual-quota FAILED error to QUOTA_EXHAUSTED with executionStarted true", async () => {
      const f = fixture();
      await expect(
        f.adapter.executeTurn(request({ task_envelope: "quota" }), gate(), () => {}),
      ).rejects.toMatchObject({
        code: "QUOTA_EXHAUSTED",
        executionStarted: true,
        message:
          "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 54m59s.",
      });
    });

    it("retains vendor detail bounded via sanitized truncation", async () => {
      const f = fixture();
      const err = await f.adapter
        .executeTurn(request({ task_envelope: "quota-long" }), gate(), () => {})
        .catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(BrokerError);
      const brokerErr = err as BrokerError;
      expect(brokerErr.code).toBe("QUOTA_EXHAUSTED");
      expect(brokerErr.executionStarted).toBe(true);
      expect(err.message).toHaveLength(513);
      expect(err.message).toMatch(/^Individual quota reached\. D+…$/);
    });

    it("does not classify SUCCESS response containing quota prose as quota", async () => {
      const f = fixture();
      const result = await f.adapter.executeTurn(
        request({ task_envelope: "success-quota-prose" }),
        gate(),
        () => {},
      );
      expect(result.native_outcome).toBe("completed");
    });

    it("does not classify FAILED response-only quota text as quota", async () => {
      const f = fixture();
      await expect(
        f.adapter.executeTurn(request({ task_envelope: "quota-response" }), gate(), () => {}),
      ).rejects.toMatchObject({
        code: "PROVIDER_PROTOCOL_ERROR",
        executionStarted: true,
        message:
          "Individual quota reached. Please upgrade your subscription to increase your limits.",
      });
    });

    it("keeps ordinary FAILED errors as PROVIDER_PROTOCOL_ERROR", async () => {
      const f = fixture();
      await expect(
        f.adapter.executeTurn(request({ task_envelope: "stream-error" }), gate(), () => {}),
      ).rejects.toMatchObject({
        code: "PROVIDER_PROTOCOL_ERROR",
        executionStarted: true,
        message: "agy failure",
      });
    });

    it("keeps generic nonzero-exit stderr as PROVIDER_PROTOCOL_ERROR", async () => {
      const f = fixture();
      await expect(
        f.adapter.executeTurn(request({ task_envelope: "nonzero" }), gate(), () => {}),
      ).rejects.toMatchObject({
        code: "PROVIDER_PROTOCOL_ERROR",
        executionStarted: true,
        message: expect.stringContaining("native agy failure"),
      });
    });
  });
});
