import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, "dist");
if (path.dirname(output) !== root) throw new Error("Build output escapes the package root.");
const previous = lstatSync(output, { throwIfNoEntry: false });
if (previous) {
  if (previous.isSymbolicLink() || realpathSync(output).toLowerCase() !== output.toLowerCase()) {
    throw new Error("Build output must be a real directory inside the package root.");
  }
  rmSync(output, { recursive: true });
}
for (const args of [
  [path.join(root, "scripts/build-ui.mjs")],
  [path.join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
  [path.join(root, "scripts/copy-package-assets.mjs")],
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
