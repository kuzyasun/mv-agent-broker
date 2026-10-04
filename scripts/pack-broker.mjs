#!/usr/bin/env node
/**
 * Packs Agent Broker as a local npm tarball and verifies the result:
 *  - the tarball contains exactly the allowlisted package files, and
 *  - the generated runtime-manifest.json matches the packed runtime files.
 *
 * No publish step: the tarball under releases/ is the distribution artifact.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeContentDigest, sha256Hex } from "./generate-runtime-manifest.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALWAYS_PACKED = ["package.json", "README.md", "LICENSE", "runtime-manifest.json"];

function runNpm(args) {
  const localCli = process.env.npm_execpath?.endsWith(".js") && existsSync(process.env.npm_execpath)
    ? process.env.npm_execpath
    : path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(localCli)) {
    const result = spawnSync(process.execPath, [localCli, ...args], {
      cwd: packageRoot, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(`npm ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
    }
    return result.stdout;
  }
  if (process.platform === "win32") throw new Error("Run packaging through npm run release:pack so npm's JavaScript entrypoint is available.");
  const result = spawnSync("npm", args, {
    cwd: packageRoot, encoding: "utf8", windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`npm ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function tarExecutable() {
  // Git Bash's GNU tar interprets drive-letter paths as remote hosts; the
  // Windows system bsdtar handles them.
  if (process.platform === "win32") {
    const systemTar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    if (existsSync(systemTar)) return systemTar;
  }
  return "tar";
}

function listTarball(tarballPath) {
  const tar = spawnSync(tarExecutable(), ["-tzf", tarballPath], {
    encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  if (tar.status !== 0 || !tar.stdout) {
    throw new Error(`tar -tzf failed for '${tarballPath}':\n${tar.stderr}`);
  }
  return tar.stdout.split(/\r?\n/).filter(Boolean);
}

function expectedPackageFiles() {
  const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const expected = new Set(ALWAYS_PACKED);
  const walk = relative => {
    const absolute = path.join(packageRoot, relative);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Pack allowlist must not contain symlinks: '${relative}'.`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolute).sort()) walk(relative ? `${relative}/${entry}` : entry);
      return;
    }
    expected.add(relative);
  };
  for (const pattern of pkg.files ?? []) {
    if (pattern.includes("*")) throw new Error(`Pack allowlist must use explicit paths, not globs: '${pattern}'.`);
    walk(pattern);
  }
  return expected;
}

function verifyTarballEntries(tarballPath) {
  const expected = expectedPackageFiles();
  const entries = listTarball(tarballPath)
    .filter(entry => !entry.endsWith("/"))
    .map(entry => (entry.startsWith("package/") ? entry.slice("package/".length) : entry));
  const actual = new Set(entries);
  const missing = [...expected].filter(entry => !actual.has(entry)).sort();
  const unexpected = [...actual].filter(entry => !expected.has(entry)).sort();
  if (missing.length || unexpected.length) {
    const detail = [
      ...missing.map(entry => `missing: ${entry}`),
      ...unexpected.map(entry => `unexpected: ${entry}`),
    ].join("\n");
    throw new Error(`Tarball contents do not match the package allowlist:\n${detail}`);
  }
  const forbidden = /(^|\/)(node_modules|tests?|\.state|\.git|coverage|\.github)(\/|$)|\.sqlite(?:-wal|-shm)?$|\.log$|\.tgz$|(^|\/)\.env/i;
  const violation = entries.find(entry => forbidden.test(entry));
  if (violation) throw new Error(`Tarball contains private or non-runtime data: '${violation}'.`);
  return entries;
}

function verifyPackedManifest(tarballPath, workspaceManifest) {
  const extractDir = mkdtempSync(path.join(tmpdir(), "broker-pack-verify-"));
  try {
    const unpacked = spawnSync(tarExecutable(), ["-xzf", tarballPath, "-C", extractDir], {
      encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    });
    if (unpacked.status !== 0) throw new Error(`tar -xzf failed:\n${unpacked.stderr}`);
    const root = path.join(extractDir, "package");
    const manifest = JSON.parse(readFileSync(path.join(root, "runtime-manifest.json"), "utf8"));
    if (manifest.origin.name !== workspaceManifest.origin.name || manifest.origin.version !== workspaceManifest.origin.version) {
      throw new Error("Packed runtime manifest identity does not match the workspace package.");
    }
    if (manifest.origin.content_sha256 !== workspaceManifest.origin.content_sha256) {
      throw new Error("Packed runtime manifest content digest differs from the workspace runtime; the tarball is stale.");
    }
    for (const file of manifest.files) {
      const bytes = readFileSync(path.join(root, ...file.path.split("/")));
      if (bytes.byteLength !== file.size || sha256Hex(bytes) !== file.sha256) {
        throw new Error(`Packed file '${file.path}' does not match the runtime manifest.`);
      }
    }
    if (computeContentDigest(manifest.files) !== manifest.origin.content_sha256) {
      throw new Error("Packed runtime manifest digest does not match its own file list.");
    }
    return manifest;
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

function main() {
  const argv = process.argv.slice(2);
  let destination = path.join(packageRoot, "releases");
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--destination") {
      const value = argv[++index];
      if (!value) throw new Error("--destination requires a directory.");
      destination = path.resolve(value);
    }
    else throw new Error(`Unknown argument '${argv[index]}'.`);
  }
  mkdirSync(destination, { recursive: true });
  const packOutput = runNpm(["pack", "--json", "--pack-destination", destination]);
  const workspaceManifest = JSON.parse(readFileSync(path.join(packageRoot, "runtime-manifest.json"), "utf8"));
  // Lifecycle script output (prepack) precedes the pretty-printed JSON array
  // on stdout; parse everything from its opening bracket.
  const jsonStart = packOutput.indexOf("\n[");
  let packed = null;
  try {
    packed = JSON.parse(jsonStart === -1 ? packOutput : packOutput.slice(jsonStart + 1));
  } catch {
    packed = null;
  }
  if (!Array.isArray(packed) || !packed[0]?.filename) {
    throw new Error(`npm pack did not report a tarball filename:\n${packOutput}`);
  }
  const tarballPath = path.join(destination, packed[0].filename);
  const entries = verifyTarballEntries(tarballPath);
  const manifest = verifyPackedManifest(tarballPath, workspaceManifest);
  process.stdout.write(`${JSON.stringify({
    tarball: tarballPath,
    files: entries.length,
    origin: manifest.origin,
  })}\n`);
}

main();
