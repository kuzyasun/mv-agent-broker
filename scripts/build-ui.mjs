import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientEntry = path.join(root, "src/operator/ui/client/main.tsx");
const jsOutput = path.join(root, "src/operator/ui/app.js");
const cssInput = path.join(root, "src/operator/ui/input.css");
const cssOutput = path.join(root, "src/operator/ui/styles.css");

await build({
  entryPoints: [clientEntry],
  outfile: jsOutput,
  bundle: true,
  format: "iife",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "preact",
  minify: true,
  legalComments: "none",
});

const tailwindBin = path.join(root, "node_modules/@tailwindcss/cli/dist/index.mjs");
const result = spawnSync(process.execPath, [tailwindBin, "-i", cssInput, "-o", cssOutput, "--minify"], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

process.stdout.write("ui: built app.js and styles.css\n");
