import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageContentDigest } from "../../src/operator/packageOrigin.ts";
import { sha256Hex } from "../../src/shared/ids.ts";

import { insertIntent } from "../../src/storage/repo.ts";
import { openRegistryDb } from "../../src/storage/db.ts";
import { ID_PREFIX, newId } from "../../src/shared/ids.ts";
import { startOperatorUi } from "../../src/operator/ui.ts";
import { pathToFileURL } from "node:url";
import { installedBrokerStatus } from "../helpers/packageMcp.ts";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

beforeAll(() => {
  const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts/build.mjs")], { cwd: repoRoot, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}, 60000);

function tarExecutable(): string {
  // Git Bash's GNU tar interprets drive-letter paths as remote hosts.
  if (process.platform === "win32") {
    const systemTar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    if (existsSync(systemTar)) return systemTar;
  }
  return "tar";
}

function runScript(script: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [path.join(repoRoot, script), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 240_000,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("npm package packing", () => {
  it("generates a manifest-verified runtime file list for the installed package", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "broker-pkg-manifest-"));
    try {
      const outfile = path.join(root, "runtime-manifest.json");
      const result = runScript("scripts/generate-runtime-manifest.mjs", ["--outfile", outfile]);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const manifest = JSON.parse(readFileSync(outfile, "utf8")) as {
        origin: { kind: string; name: string; version: string; content_sha256: string };
        files: Array<{ path: string; mode: string; size: number; sha256: string }>;
      };
      const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { name: string; version: string };
      expect(manifest.origin.kind).toBe("npm-package");
      expect(manifest.origin.name).toBe(pkg.name);
      expect(manifest.origin.version).toBe(pkg.version);
      const paths = manifest.files.map(file => file.path);
      // The executable runtime ships: entrypoints, compiled UI assets, Windows helpers.
      for (const needed of [
        "package.json",
        "dist/operator/main.js",
        "dist/operator/launchDaemon.ps1",
        "dist/operator/ui/app.js",
        "dist/operator/ui/index.html",
        "dist/operator/ui/styles.css",
        "dist/providers/common/windowsJobHelper.ps1",
        "dist/bridge/main-stdio.js",
      ]) {
        expect(paths).toContain(needed);
      }
      // Nothing outside dist/ plus package.json belongs in the frozen runtime.
      for (const entry of paths) {
        expect(entry === "package.json" || entry.startsWith("dist/")).toBe(true);
      }
      // Cross-implementation check: the TypeScript verifier agrees with the generator.
      for (const file of manifest.files) {
        expect(sha256Hex(readFileSync(path.join(repoRoot, ...file.path.split("/"))))).toBe(file.sha256);
      }
      expect(packageContentDigest(manifest.files)).toBe(manifest.origin.content_sha256);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("packs a tarball limited to the allowlist with a matching runtime manifest", () => {
    const destination = mkdtempSync(path.join(os.tmpdir(), "broker-pkg-dest-"));
    try {
      const result = runScript("scripts/pack-broker.mjs", ["--destination", destination]);
      if (result.status !== 0) throw new Error(`pack failed:\n${result.stdout}\n${result.stderr}`);
      const summaryLine = result.stdout.trim().split(/\r?\n/).pop() ?? "";
      const summary = JSON.parse(summaryLine) as { tarball: string; files: number };
      expect(existsSync(summary.tarball)).toBe(true);
      expect(summary.files).toBeGreaterThan(10);

      const listed = spawnSync(tarExecutable(), ["-tzf", summary.tarball], { encoding: "utf8", windowsHide: true });
      expect(listed.status).toBe(0);
      const entries = (listed.stdout ?? "").split(/\r?\n/).filter(Boolean)
        .map(entry => entry.startsWith("package/") ? entry.slice("package/".length) : entry);
      for (const needed of [
        "package.json",
        "README.md",
        "LICENSE",
        "runtime-manifest.json",
        "bin/agent-broker.js",
        "scripts/start-ui.ps1",
        "docs/providers.md",
        "docs/operator-guide.md",
        "docs/coordinator-instructions.md",
        "docs/examples/operator.mock.json",
        "dist/operator/ui/styles.css",
        "dist/providers/common/windowsJobHelper.ps1",
        "dist/providers/cursor/permissionHook.mjs",
      ]) {
        expect(entries).toContain(needed);
      }
      // No private runtime, config, cache, test, or VCS data.
      const forbidden = /(^|\/)(node_modules|tests?|\.state|\.git|\.github|coverage|src)(\/|$)|\.sqlite(?:-wal|-shm)?$|\.log$|\.tgz$|(^|\/)\.env|^docs\/(native-smoke|plans|validation|coordinator-projects|decisions)\//;
      const violation = entries.find(entry => forbidden.test(entry));
      expect(violation).toBeUndefined();
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  }, 300_000);
});

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function node(args: string[], cwd: string, timeout = 90_000): CliResult {
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function jsonCli(bin: string, args: string[], cwd: string): Record<string, unknown> {
  const result = node([bin, ...args], cwd);
  if (result.status !== 0) {
    throw new Error(`agent-broker ${args.join(" ")} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function npmInstall(tarball: string, cwd: string): void {
  const localCli = process.env.npm_execpath?.endsWith(".js") && existsSync(process.env.npm_execpath)
    ? process.env.npm_execpath
    : path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const args = ["install", "--no-save", "--no-audit", "--no-fund", "--loglevel=error", tarball];
  const result = existsSync(localCli)
    ? spawnSync(process.execPath, [localCli, ...args], { cwd, encoding: "utf8", windowsHide: true, timeout: 180_000 })
    : spawnSync("npm", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 180_000 });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`npm install failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
}

describe("installed package lifecycle", () => {
  // Pack, install to an isolated prefix, then run the CLI lifecycle with a
  // mock-free empty config: no Git checkout and no inference involved.
  it("packs, installs to an isolated prefix, and runs init/validate/start/status/stop without the Git checkout", async () => {
    const destination = mkdtempSync(path.join(os.tmpdir(), "broker-inst-dest-"));
    const prefix = mkdtempSync(path.join(os.tmpdir(), "broker install prefix-"));
    const work = mkdtempSync(path.join(os.tmpdir(), "broker install work-"));
    const roots = [destination, prefix, work];
    const cleanup = () => {
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    };
    let stateDir: string | undefined;
    try {
      // 1. Build the tarball (also exercises prepack manifest generation).
      const packed = node(
        [path.join(repoRoot, "scripts", "pack-broker.mjs"), "--destination", destination],
        repoRoot,
        240_000,
      );
      if (packed.status !== 0) throw new Error(`pack failed:\n${packed.stdout}\n${packed.stderr}`);
      const summary = JSON.parse(packed.stdout.trim().split(/\r?\n/).pop() ?? "{}") as { tarball: string; origin: { version: string } };
      expect(existsSync(summary.tarball)).toBe(true);

      // 2. Install to the isolated prefix (zero runtime deps; no network use).
      writeFileSync(path.join(prefix, "package.json"), JSON.stringify({ name: "broker-install-smoke", version: "0.0.0", private: true }));
      npmInstall(summary.tarball, prefix);
      const installedRoot = path.join(prefix, "node_modules", "@gemslibe", "agent-broker");
      const bin = path.join(installedRoot, "bin", "agent-broker.js");
      expect(existsSync(bin)).toBe(true);
      expect(existsSync(path.join(prefix, "node_modules", ".bin", process.platform === "win32" ? "agent-broker.cmd" : "agent-broker"))).toBe(true);
      expect(existsSync(path.join(installedRoot, "runtime-manifest.json"))).toBe(true);

      // 3. Help and version work without any configuration.
      const help = node([bin, "--help"], work);
      expect(help.status).toBe(0);
      expect(help.stdout).toContain("init");
      expect(help.stdout).toContain("--config");
      const version = node([bin, "--version"], work);
      expect(version.status).toBe(0);
      expect(version.stdout.trim()).toBe(summary.origin.version);

      // 4. init writes a minimal valid empty config and refuses overwrite.
      const configPath = path.join(work, "operator.json");
      const initialized = jsonCli(bin, ["init", "--config", configPath], work);
      expect(initialized.config).toBe(path.resolve(configPath));
      expect(initialized.state_dir).toBe(path.join(work, "agent-broker-state"));
      const written = JSON.parse(readFileSync(configPath, "utf8")) as { state_dir: string; projects: unknown[] };
      expect(written.projects).toEqual([]);
      expect(() => jsonCli(bin, ["init", "--config", configPath], work)).toThrow(/Refusing to overwrite/);
      expect(jsonCli(bin, ["validate", "--config", configPath], work)).toMatchObject({ valid: true, projects: 0, routes: 0 });
      stateDir = path.join(work, "agent-broker-state");

      // 5. start freezes the installed package into the state directory.
      const running = jsonCli(bin, ["start", "--config", configPath], work);
      expect(running.readiness).toBe("READY");
      expect(running.runtime_commit).toBeNull();
      expect(running.runtime_origin).toEqual({
        kind: "npm-package",
        name: "@gemslibe/agent-broker",
        version: summary.origin.version,
        content_sha256: expect.any(String),
      });
      expect(String(running.runtime_identity)).toMatch(/^package:@gemslibe\/agent-broker@/);
      expect(String(running.runtime_path).startsWith(path.join(stateDir, "runtimes"))).toBe(true);
      const frozenManifest = JSON.parse(readFileSync(path.join(String(running.runtime_path), "runtime-manifest.json"), "utf8")) as { origin: unknown };
      expect(frozenManifest.origin).toEqual(running.runtime_origin);
      // --ref is a development-only option and must be refused for packages.
      expect(() => jsonCli(bin, ["start", "--ref", "HEAD~1", "--config", configPath], work)).toThrow(/--ref requires running from a development Git checkout/);

      // 6. status and mcp-config --connect agree with the running daemon.
      const status = jsonCli(bin, ["status", "--config", configPath], work);
      expect(status.status).toBe("ready");
      expect(status.runtime_identity).toBe(running.runtime_identity);
      expect(status.daemon_pid).toBe(running.daemon_pid);
      const snippet = jsonCli(bin, ["mcp-config", "--connect", "--config", configPath], work) as {
        mcpServers: { "agent-broker": { args: string[]; env: { AB_STATE_DIR: string } } };
      };
      expect(snippet.mcpServers["agent-broker"].args[0]).toBe(path.join(String(running.runtime_path), "dist", "bridge", "main-stdio.js"));
      expect(snippet.mcpServers["agent-broker"].env.AB_STATE_DIR).toBe(stateDir);
      const mcp = await installedBrokerStatus(snippet.mcpServers["agent-broker"] as unknown as { command: string; args: string[]; env: Record<string, string> });
      expect(mcp.daemon_state).toBe("READY");

      // Exercise the installed frozen UI, including a config restart.
      const compiledUi = await import(pathToFileURL(path.join(String(running.runtime_path), "dist/operator/ui.js")).href);
      const ui = await compiledUi.startOperatorUi({ configPath, port: 0, scriptPath: path.join(String(running.runtime_path), "dist/operator/main.js") });
      try {
        expect((await fetch(ui.url)).status).toBe(200);
        expect((await fetch(ui.url + "/styles.css")).status).toBe(200);
        const headers = { "x-operator-token": ui.token, "content-type": "application/json" };
        const saved = await (await fetch(ui.url + "/api/config", { headers })).json();
        const restarted = await fetch(ui.url + "/api/restart", { method: "POST", headers, body: JSON.stringify({ revision: saved.revision }) });
        expect(restarted.status).toBe(200);
        expect((await restarted.json()).runtime_identity).toBe(running.runtime_identity);
      } finally { await ui.close(); }
      if (process.platform === "win32") {
        const socket = createServer();
        await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
        const port = (socket.address() as { port: number }).port;
        await new Promise<void>(resolve => socket.close(() => resolve()));
        const ps = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
        const launched = JSON.parse(execFileSync(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
          path.join(installedRoot, "scripts/start-ui.ps1"), "-ConfigPath", configPath, "-Port", String(port), "-NodePath", process.execPath],
          { encoding: "utf8", windowsHide: true, timeout: 20000 }));
        try {
          expect(launched.runtime_identity).toBe(running.runtime_identity);
          expect((await fetch(launched.url)).status).toBe(200);
        } finally {
          const creation = String(launched.creation_date).replaceAll("'", "''");
          execFileSync(ps, ["-NoProfile", "-Command", `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(launched.pid)}'; if ($p -and $p.CreationDate.ToUniversalTime().ToString('o') -eq '${creation}') { Stop-Process -Id $p.ProcessId }`],
            { windowsHide: true, timeout: 15000 });
        }
      }

      // 7. Active-turn stop guards hold for package-origin runtimes.
      const blocking = openRegistryDb(path.join(stateDir, "registry.sqlite"));
      try {
        insertIntent(blocking, {
          intent_id: newId(ID_PREFIX.intent),
          kind: "input_publication",
          session_id: null,
          turn_id: null,
          state: "pending",
          payload: "{}",
          created_at: Date.now(),
          updated_at: Date.now(),
        });
      } finally {
        blocking.close();
      }
      expect(() => jsonCli(bin, ["stop", "--config", configPath], work)).toThrow(/RESOURCE_BUSY/);
      const clear = openRegistryDb(path.join(stateDir, "registry.sqlite"));
      try {
        clear.raw.prepare("DELETE FROM intents WHERE kind = ?").run("input_publication");
      } finally {
        clear.close();
      }

      // 8. The frozen runtime keeps running after the installed package is removed.
      rmSync(installedRoot, { recursive: true, force: true, maxRetries: 3 });
      const frozenMain = path.join(String(running.runtime_path), "dist", "operator", "main.js");
      const frozenStatus = jsonCli(frozenMain, ["status", "--config", configPath], work);
      expect(frozenStatus.status).toBe("ready");
      expect(frozenStatus.runtime_identity).toBe(running.runtime_identity);
      const stopped = jsonCli(frozenMain, ["stop", "--config", configPath], work);
      expect(stopped.status).toBe("stopped");
      expect(stopped.runtime_identity).toBe(running.runtime_identity);
      expect(existsSync(path.join(stateDir, "daemon.lock"))).toBe(false);
      const afterStop = jsonCli(frozenMain, ["status", "--config", configPath], work);
      expect(afterStop.status).toBe("stopped");
      expect(afterStop.runtime_identity).toBe(running.runtime_identity);
    } finally {
      if (stateDir && existsSync(path.join(stateDir, "daemon.lock"))) {
        try {
          const record = JSON.parse(readFileSync(path.join(stateDir, "operator-runtime.json"), "utf8")) as { runtime_path?: string };
          if (record.runtime_path && existsSync(record.runtime_path)) {
            node([path.join(record.runtime_path, "dist", "operator", "main.js"), "stop", "--config", path.join(work, "operator.json")], work, 30_000);
          }
        } catch { /* best-effort cleanup */ }
      }
      cleanup();
    }
  }, 480_000);
});
