#!/usr/bin/env node
/**
 * Copies the non-TypeScript runtime assets from src/ into dist/ after tsc
 * emits the compiled package: the operator UI files, Windows PowerShell
 * launchers/helpers, and the cursor permission hook. tsc only emits .js for
 * .ts sources, so this step completes the executable dist/ tree that the
 * npm package freezes into broker state.
 */
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = path.join(repoRoot, "src");
const distRoot = path.join(repoRoot, "dist");
const ASSET_EXTENSIONS = new Set([".css", ".html", ".js", ".json", ".mjs", ".ps1"]);

function copyAssets(sourceDir, distDir) {
  mkdirSync(distDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const distPath = path.join(distDir, entry.name);
    if (entry.isDirectory()) {
      copyAssets(sourcePath, distPath);
    } else if (entry.isFile() && ASSET_EXTENSIONS.has(path.extname(entry.name))) {
      cpSync(sourcePath, distPath);
    }
  }
}

copyAssets(sourceRoot, distRoot);
process.stdout.write("dist: copied src runtime assets\n");
