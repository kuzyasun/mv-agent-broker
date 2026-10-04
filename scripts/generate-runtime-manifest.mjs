#!/usr/bin/env node
/**
 * Generates runtime-manifest.json: the manifest-verified runtime file list an
 * installed npm package freezes into broker state at `start`.
 *
 * The manifest covers exactly the executable runtime (the compiled dist/ tree
 * and package.json) and declares its Node entry point. Node 24 refuses
 * TypeScript type stripping under node_modules, so the package ships
 * compiled JavaScript and runs plain Node. `origin.content_sha256` is a
 * content digest over that verified list; it is honest package identity and
 * is never presented as a Git commit. Development checkouts keep freezing
 * Git snapshots and do not use this manifest.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_ROOT_FILES = ["package.json"];
const RUNTIME_ROOTS = ["dist"];
const RUNTIME_ENTRY = "dist/operator/main.js";

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function listRuntimeFiles(packageRoot) {
  const files = [];
  const visit = (absolute, relative) => {
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Runtime file '${relative}' must be a regular file, not a symlink.`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(absolute).sort()) {
        visit(path.join(absolute, entry), `${relative}/${entry}`);
      }
      return;
    }
    if (!stat.isFile()) throw new Error(`Runtime file '${relative}' must be a regular file.`);
    files.push({
      path: relative,
      mode: "100644",
      size: stat.size,
      sha256: sha256Hex(readFileSync(absolute)),
    });
  };
  for (const root of RUNTIME_ROOT_FILES) visit(path.join(packageRoot, root), root);
  for (const root of RUNTIME_ROOTS) visit(path.join(packageRoot, root), root);
  return files;
}

/** Content digest over a sorted `path\nsha256\n` canonical serialization. */
export function computeContentDigest(files) {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(`${file.path}\n${file.sha256}\n`);
  }
  return hash.digest("hex");
}

export function buildRuntimeManifest(packageRoot) {
  const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (typeof pkg.name !== "string" || !pkg.name || typeof pkg.version !== "string" || !pkg.version) {
    throw new Error("package.json must declare a name and version before packing.");
  }
  if (!existsSync(path.join(packageRoot, RUNTIME_ENTRY))) {
    throw new Error(`Compiled runtime is missing at '${RUNTIME_ENTRY}'; run 'npm run build' before packing.`);
  }
  const files = listRuntimeFiles(packageRoot);
  return {
    origin: {
      kind: "npm-package",
      name: pkg.name,
      version: pkg.version,
      content_sha256: computeContentDigest(files),
    },
    runtime: { entry: RUNTIME_ENTRY },
    files,
  };
}

function main() {
  const argv = process.argv.slice(2);
  let packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let outfile = path.join(packageRoot, "runtime-manifest.json");
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--package-root") packageRoot = path.resolve(argv[++index]);
    else if (argv[index] === "--outfile") outfile = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument '${argv[index]}'.`);
  }
  const manifest = buildRuntimeManifest(packageRoot);
  writeFileSync(outfile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${path.basename(outfile)}: ${manifest.files.length} runtime files, content ${manifest.origin.content_sha256}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) main();
