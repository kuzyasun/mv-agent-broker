import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../shared/ids.ts";

/**
 * Runtime origin identity for frozen broker runtimes.
 *
 * A frozen runtime is either a development Git snapshot (`git`, with the full
 * commit) or a copy of an installed npm package (`npm-package`, identified by
 * package name, version, and a content digest of its manifest-verified file
 * list). The content digest is package identity and is never presented as a
 * Git commit.
 */
export type RuntimeOrigin =
  | { kind: "git"; commit: string }
  | { kind: "npm-package"; name: string; version: string; content_sha256: string };

export interface RuntimeManifestFile {
  path: string;
  mode: string;
  size: number;
  sha256: string;
  /** Git blob id; present only for Git-extracted runtimes. */
  oid?: string;
}

export interface RuntimeManifest {
  origin: RuntimeOrigin;
  /**
   * The executable entry of the frozen runtime, relative to the runtime root.
   * Git snapshots keep TypeScript sources and need the transform flag;
   * installed packages freeze compiled dist output and run plain Node.
   */
  runtime: { entry: string };
  files: RuntimeManifestFile[];
}

export interface RuntimeRecord {
  runtime_origin: RuntimeOrigin;
  runtime_identity: string;
  runtime_path: string;
  manifest_path: string;
  runtime_files: number;
  config_path: string;
  daemon_pid: number;
  process_identity: string;
  started_at: number;
}

export const PACKAGE_MANIFEST_NAME = "runtime-manifest.json";

const GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/i;
const CONTENT_DIGEST_PATTERN = /^[0-9a-f]{64}$/i;
const RUNTIME_ENTRY_PATTERN = /^[a-zA-Z0-9._/-]+\.(?:ts|mjs|js)$/;

function parseRuntimeEntry(value: unknown): string | null {
  if (typeof value !== "string" || !RUNTIME_ENTRY_PATTERN.test(value) || value.split(/[\\/]/).includes("..")) {
    return null;
  }
  if (path.isAbsolute(value) || value.startsWith("/")) return null;
  return value;
}

/**
 * The frozen runtime entrypoint and whether it needs Node's TypeScript
 * transform flag. Git snapshots keep .ts sources; installed packages freeze
 * compiled .js output (Node 24 refuses type stripping under node_modules, so
 * a package must never require the flag at its install location).
 */
export function runtimeEntryInfo(runtimePath: string): { entryPath: string; nodeArgs: string[] } | null {
  const manifest = readRuntimeManifest(runtimePath);
  if (!manifest) return null;
  const entryPath = path.resolve(runtimePath, ...manifest.runtime.entry.split("/"));
  return {
    entryPath,
    nodeArgs: manifest.runtime.entry.endsWith(".ts") ? ["--experimental-transform-types"] : [],
  };
}

/** The broker package root: two levels above this module directory. */
export function packageRootFromSource(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

/** Source development uses src/; distributed builds use dist/. */
export function isPackageBuild(): boolean {
  return path.basename(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")) === "dist";
}

export function isValidRuntimeOrigin(value: unknown): value is RuntimeOrigin {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const origin = value as Record<string, unknown>;
  if (origin.kind === "git") {
    return typeof origin.commit === "string" && GIT_COMMIT_PATTERN.test(origin.commit);
  }
  if (origin.kind === "npm-package") {
    return (
      typeof origin.name === "string" && origin.name.length > 0 &&
      typeof origin.version === "string" && origin.version.length > 0 &&
      typeof origin.content_sha256 === "string" && CONTENT_DIGEST_PATTERN.test(origin.content_sha256)
    );
  }
  return false;
}

export function runtimeIdentity(origin: RuntimeOrigin): string {
  return origin.kind === "git"
    ? `git:${origin.commit}`
    : `package:${origin.name}@${origin.version}:${origin.content_sha256}`;
}

/** Content digest over a sorted `path\nsha256\n` canonical serialization. */
export function packageContentDigest(files: ReadonlyArray<{ path: string; sha256: string }>): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${file.path}\n${file.sha256}\n`);
  }
  return hash.digest("hex");
}

/**
 * Read and verify a runtime manifest file at a runtime/package root.
 * Accepts both origin kinds: a running daemon reads its own frozen manifest,
 * whatever kind of checkout produced it. Returns null when the manifest is
 * absent, malformed, or (for package origins) its content digest does not
 * match the declared file list.
 */
export function readRuntimeManifest(packageRoot: string): RuntimeManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path.join(packageRoot, PACKAGE_MANIFEST_NAME), "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  if (!isValidRuntimeOrigin(raw.origin)) return null;
  const entry = raw.runtime && typeof raw.runtime === "object" && !Array.isArray(raw.runtime)
    ? parseRuntimeEntry((raw.runtime as Record<string, unknown>).entry)
    : null;
  if (!entry) return null;
  if (entry !== (raw.origin.kind === "git" ? "src/operator/main.ts" : "dist/operator/main.js")) return null;
  if (!Array.isArray(raw.files) || raw.files.length === 0) return null;
  const files: RuntimeManifestFile[] = [];
  const seen = new Set<string>();
  for (const entry of raw.files) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const file = entry as Partial<RuntimeManifestFile>;
    if (
      typeof file.path !== "string" || file.path.length === 0 ||
      typeof file.mode !== "string" ||
      typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0 ||
      typeof file.sha256 !== "string" || !CONTENT_DIGEST_PATTERN.test(file.sha256)
    ) return null;
    if (path.isAbsolute(file.path) || file.path.split(/[\\/]/).some(part => part === ".." || part === "")) return null;
    if (seen.has(file.path) || (file.mode !== "100644" && file.mode !== "100755")) return null;
    seen.add(file.path);
    files.push({ path: file.path, mode: file.mode, size: file.size, sha256: file.sha256 });
  }
  if (!seen.has(entry) || !seen.has("package.json")) return null;
  if (raw.origin.kind === "npm-package" && packageContentDigest(files) !== raw.origin.content_sha256) return null;
  return { origin: raw.origin, runtime: { entry }, files };
}

/**
 * Read and fully verify the installed package manifest at a package root.
 * Unlike readRuntimeManifest, only npm-package origins count: installed
 * package detection must not mistake a frozen development snapshot for a
 * package installation.
 */
export function readPackageManifest(packageRoot: string): RuntimeManifest | null {
  const manifest = readRuntimeManifest(packageRoot);
  return manifest?.origin.kind === "npm-package" ? manifest : null;
}

function safeChildPath(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
    throw new Error(`Invalid runtime file path '${relativePath}'.`);
  }
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Invalid runtime file path '${relativePath}'.`);
  }
  return target;
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(temporary, filePath);
}

/**
 * Freeze the installed package into the state-owned runtimes directory.
 * Only files verified against the generated package manifest are copied;
 * the frozen copy keeps the same manifest, so restart identity survives
 * replacement or removal of the installed package.
 */
export function extractPackageRuntime(
  packageRoot: string,
  stateDir: string,
  configPath: string,
): { record: RuntimeRecord; manifest: RuntimeManifest } {
  const manifest = readPackageManifest(packageRoot);
  if (!manifest) {
    throw new Error(
      `INSTALLED_PACKAGE_INVALID: '${PACKAGE_MANIFEST_NAME}' is missing or failed verification in '${packageRoot}'.`,
    );
  }
  const runtimeRoot = path.join(path.resolve(stateDir), "runtimes");
  mkdirSync(runtimeRoot, { recursive: true });
  const runtimePath = path.join(runtimeRoot, `${Date.now()}-${randomUUID()}`);
  mkdirSync(runtimePath, { recursive: true });
  for (const file of manifest.files) {
    const source = safeChildPath(packageRoot, file.path);
    const target = safeChildPath(runtimePath, file.path);
    const stat = lstatSync(source, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Installed package runtime file '${file.path}' is missing or not a regular file.`);
    }
    const contents = readFileSync(source);
    if (contents.byteLength !== file.size) {
      throw new Error(`Installed package file '${file.path}' does not match its manifest size.`);
    }
    if (sha256Hex(contents) !== file.sha256) {
      throw new Error(`Installed package file '${file.path}' failed its manifest checksum.`);
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
    if (file.mode === "100755") {
      try { chmodSync(target, 0o755); } catch { /* best effort on Windows */ }
    }
  }
  const manifestPath = path.join(runtimePath, PACKAGE_MANIFEST_NAME);
  writeJsonAtomically(manifestPath, manifest);
  const record: RuntimeRecord = {
    runtime_origin: manifest.origin,
    runtime_identity: runtimeIdentity(manifest.origin),
    runtime_path: runtimePath,
    manifest_path: manifestPath,
    runtime_files: manifest.files.length,
    config_path: path.resolve(configPath),
    daemon_pid: 0,
    process_identity: "",
    started_at: Date.now(),
  };
  return { record, manifest };
}
