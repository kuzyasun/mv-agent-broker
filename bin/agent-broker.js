#!/usr/bin/env node
// Executable shim for the installed agent-broker package. The package ships
// compiled JavaScript under dist/ because Node 24 refuses TypeScript type
// stripping for files under node_modules; plain Node runs it directly, with
// no flags and no dependencies.
"use strict";

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = path.join(packageRoot, "dist", "operator", "main.js");

if (!existsSync(entrypoint)) {
  process.stderr.write(`agent-broker: installation is incomplete; ${entrypoint} is missing. Reinstall the package tarball.\n`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [entrypoint, ...process.argv.slice(2)],
  { stdio: "inherit", windowsHide: true },
);

if (result.error) {
  process.stderr.write(`agent-broker: failed to launch Node.js: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
