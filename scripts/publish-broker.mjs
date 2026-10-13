#!/usr/bin/env node
/**
 * Publishes the packed Agent Broker tarball to npm.
 *
 * Safety gate: requires RELEASE_CONFIRM=1 or --yes / -y.
 * Does not bump versions or pack; run 'npm run release:pack' first.
 *
 * Authentication:
 *   - npm Trusted Publishing (OIDC) in GitHub Actions, or
 *   - npm login for manual local fallback.
 *
 * Usage (from repo root):
 *   RELEASE_CONFIRM=1 npm run release:publish
 *   npm run release:publish -- --yes
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function confirmed() {
  const args = process.argv.slice(2);
  if (args.includes("--yes") || args.includes("-y")) {
    return true;
  }
  return process.env.RELEASE_CONFIRM === "1";
}

function packedTarball() {
  const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const tarballName = `${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`;
  return path.join(packageRoot, "releases", tarballName);
}

function main() {
  if (!confirmed()) {
    fail(
      "refusing to publish without confirmation.\n" +
      "  Set RELEASE_CONFIRM=1 or pass --yes / -y.\n" +
      "  Example (PowerShell):\n" +
      "    $env:RELEASE_CONFIRM = '1'; npm run release:publish\n" +
      "    npm run release:publish -- --yes\n" +
      "  Authentication: npm Trusted Publishing in GitHub Actions, or npm login for manual fallback."
    );
  }

  const tarball = packedTarball();
  if (!existsSync(tarball)) {
    fail(`missing tarball at '${tarball}'. Run 'npm run release:pack' first.`);
  }

  const usingTrustedPublishing = Boolean(
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  );

  console.log(`Publishing ${path.basename(tarball)} to npm...`);
  console.log(
    usingTrustedPublishing
      ? "(npm Trusted Publishing via GitHub Actions OIDC)"
      : "(interactive npm authentication with publish access required)"
  );

  const result = spawnSync("npm", ["publish", "--access", "public", tarball], {
    cwd: packageRoot,
    stdio: "inherit",
    shell: true,
    env: process.env,
  });

  if (result.error) {
    fail(`npm publish failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`npm publish exited with code ${result.status ?? "unknown"}`);
  }

  console.log("release:publish ok — package published successfully");
}

main();
