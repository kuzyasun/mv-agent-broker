import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { closeSync, chmodSync, existsSync, lstatSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir as readdirAsync, realpath as realpathAsync, stat as statAsync } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonRpcError } from "../bridge/rpcClient.ts";
import { validateOperatorConfig, type OperatorConfig } from "./config.ts";
import { statusOperator } from "./operations.ts";
import { parseAntigravityModelCatalog } from "../providers/antigravity/antigravityAdapter.ts";
import { parseCursorModelCatalog, resolveCursorModel } from "../providers/cursor/cursorAdapter.ts";
import { boundedSanitizedDetail, resolveBinaryPath, runMetadataProbe } from "../providers/common/readiness.ts";
import { createZcodePersonalConfig, readZcodeInstalledCatalog, resolveZcodeBuiltinPath } from "../providers/zcode/nativeConfig.ts";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_FOLDER_ENTRIES = 2000;
const DEFAULT_PORT = 4318;
const TOKEN_HEADER = "x-operator-token";
const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui");

export interface CatalogObservation {
  provider: string;
  models: string[];
  observed_at: number;
  source: "cli_metadata_probe" | "config_catalog";
  detail: string | null;
}

export type CatalogReader = (
  provider: string,
  config: OperatorConfig,
  configPath: string,
) => CatalogObservation | Promise<CatalogObservation>;

export interface OperatorUiOptions {
  configPath: string;
  port?: number;
  scriptPath?: string;
  readCatalog?: CatalogReader;
}

export interface OperatorUiService {
  readonly url: string;
  readonly token: string;
  readonly port: number;
  close(): Promise<void>;
}

interface RawConfigFile {
  bytes: Buffer;
  value: Record<string, unknown>;
  mode: number;
}

interface ModelOption {
  model: string;
  efforts: string[];
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertRegularConfig(configPath: string): void {
  const stat = lstatSync(configPath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error("operator config must be a regular file");
}

function readRawConfig(configPath: string): RawConfigFile {
  assertRegularConfig(configPath);
  const bytes = readFileSync(configPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("operator config is not valid JSON");
  }
  if (!isRecord(parsed)) throw new Error("operator config root must be an object");
  return { bytes, value: parsed, mode: statSync(configPath).mode & 0o777 };
}

function validateRawConfig(configPath: string, value: Record<string, unknown>): OperatorConfig {
  const clone = JSON.parse(JSON.stringify(value)) as unknown;
  return validateOperatorConfig(clone, path.dirname(configPath));
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return boundedSanitizedDetail(message, 240) || "invalid operator config";
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendText(response: ServerResponse, status: number, body: string, contentType: string): void {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "content-security-policy": "frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function createUniqueFile(filePath: string, bytes: Buffer, mode: number): void {
  const fd = openSync(filePath, "wx", mode);
  try {
    writeFileSync(fd, bytes);
    chmodSync(filePath, mode);
  } finally {
    closeSync(fd);
  }
}

function backupPath(configPath: string): string {
  const directory = path.dirname(configPath);
  const name = path.basename(configPath);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = path.join(directory, `${name}.backup.${Date.now()}-${randomBytes(8).toString("hex")}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("could not allocate a unique config backup");
}

function writeConfigAtomically(configPath: string, previous: RawConfigFile, value: Record<string, unknown>): string {
  assertRegularConfig(configPath);
  const directory = path.dirname(configPath);
  const temporary = path.join(directory, `.${path.basename(configPath)}.operator-ui-${randomBytes(12).toString("hex")}.tmp`);
  const backup = backupPath(configPath);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    createUniqueFile(backup, previous.bytes, previous.mode);
    createUniqueFile(temporary, bytes, previous.mode);
    renameSync(temporary, configPath);
    return backup;
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* owned temp may already have been renamed */ }
    throw error;
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    throw new Error("request body exceeds 1 MiB");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_BODY_BYTES) throw new Error("request body exceeds 1 MiB");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function parseJsonBody(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("request body must be JSON");
  }
}

function expectedOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function folderRoots(): string[] {
  if (process.platform !== "win32") return [path.parse(path.resolve("/")).root];
  const roots: string[] = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (existsSync(root)) roots.push(root);
  }
  return roots;
}

function startupFolder(configPath: string, config: OperatorConfig): string {
  const workspace = config.workspaces.find(item =>
    item.mode === "current" && typeof item.canonical_path === "string" && existsSync(item.canonical_path) &&
    statSync(item.canonical_path, { throwIfNoEntry: false })?.isDirectory(),
  );
  return workspace?.canonical_path ? path.resolve(workspace.canonical_path) : path.dirname(path.resolve(configPath));
}

async function listFolder(body: unknown, fallback: string): Promise<{
  path: string;
  parent: string | null;
  directories: Array<{ name: string; path: string }>;
  entries: Array<{ name: string; kind: "directory" | "file" }>;
  roots: string[];
}> {
  if (body !== undefined && (!isRecord(body) || (body.path !== undefined && typeof body.path !== "string"))) {
    throw new Error("path must be an absolute directory path");
  }
  const requested: unknown = isRecord(body) && body.path !== undefined ? body.path : fallback;
  if (typeof requested !== "string" || !path.isAbsolute(requested) || requested.trim().length === 0) {
    throw new Error("path must be an absolute directory path");
  }
  const canonical = await realpathAsync(requested);
  const folderStat = await statAsync(canonical);
  if (!folderStat.isDirectory()) throw new Error("path must be an existing directory");
  const dirents = await readdirAsync(canonical, { withFileTypes: true });
  if (dirents.length > MAX_FOLDER_ENTRIES) throw new Error(`directory contains more than ${MAX_FOLDER_ENTRIES} entries`);
  const entries = dirents
    .filter(entry => !entry.isSymbolicLink())
    .map(entry => ({
      name: entry.name,
      kind: entry.isDirectory() ? "directory" as const : "file" as const,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const directories = entries
    .filter(entry => entry.kind === "directory")
    .map(entry => ({ name: entry.name, path: path.join(canonical, entry.name) }));
  const root = path.parse(canonical).root;
  return {
    path: canonical,
    parent: canonical === root ? null : path.dirname(canonical),
    directories,
    entries,
    roots: folderRoots(),
  };
}

function checkRequest(request: IncomingMessage, token: string, port: number): number | null {
  if (request.headers.host !== `127.0.0.1:${port}`) return 403;
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== expectedOrigin(port)) return 403;
  const supplied = request.headers[TOKEN_HEADER];
  if (typeof supplied !== "string") return 401;
  const left = Buffer.from(supplied);
  const right = Buffer.from(token);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return 401;
  return null;
}

function configuredModels(config: OperatorConfig, provider: string): string[] {
  return [...new Set(config.routes.filter(route => route.provider === provider).map(route => route.model))];
}

function observation(provider: string, models: string[], source: CatalogObservation["source"], detail: string | null = null): CatalogObservation {
  return { provider, models: [...new Set(models)].slice(0, 4096), observed_at: Date.now(), source, detail };
}

function metadataFailure(provider: string, detail = "metadata unavailable"): CatalogObservation {
  return observation(provider, [], "cli_metadata_probe", detail);
}

export async function defaultCatalogReader(provider: string, config: OperatorConfig, _configPath: string): Promise<CatalogObservation> {
  if (provider === "mock") return observation(provider, configuredModels(config, provider), "config_catalog", "Configured mock choices; no vendor catalogue.");
  const pins = config.native_binary_pins ?? {};
  if (provider === "cursor") {
    const binary = pins.cursor;
    if (!binary) return metadataFailure(provider, "provider binary is not pinned");
    const resolved = resolveBinaryPath(binary);
    if (!resolved) return metadataFailure(provider);
    const models = runMetadataProbe({ binary: resolved, argv: ["--list-models"], cwd: process.cwd(), envAllowlist: ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"] });
    if (!models.ok) return metadataFailure(provider);
    return observation(provider, parseCursorModelCatalog(models.stdout), "cli_metadata_probe");
  }
  if (provider === "antigravity") {
    const binary = pins.antigravity;
    if (!binary) return metadataFailure(provider, "provider binary is not pinned");
    const resolved = resolveBinaryPath(binary);
    if (!resolved) return metadataFailure(provider);
    const models = runMetadataProbe({ binary: resolved, argv: ["models"], cwd: process.cwd(), envAllowlist: ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"] });
    return models.ok ? observation(provider, parseAntigravityModelCatalog(models.stdout), "cli_metadata_probe") : metadataFailure(provider);
  }
  if (provider === "zcode") {
    try {
      const bundle = pins.zcode ?? pins["zcode-bundle"];
      if (!bundle) return metadataFailure(provider, "provider bundle is not pinned");
      const builtin = resolveZcodeBuiltinPath(bundle, pins["zcode-config"]);
      const catalog = readZcodeInstalledCatalog(builtin);
      const models = catalog.individual_catalog.filter(model => {
        try { createZcodePersonalConfig(builtin, model, "low"); return true; } catch { return false; }
      }).map(model => model.split("/").pop() ?? model);
      return observation(provider, models, "config_catalog");
    } catch {
      return metadataFailure(provider, "installed catalog unavailable");
    }
  }
  return metadataFailure(provider, "provider metadata is not supported");
}

function addModelOption(map: Map<string, Set<string>>, model: string, effort: string): void {
  const efforts = map.get(model) ?? new Set<string>();
  efforts.add(effort);
  map.set(model, efforts);
}

export function buildModelOptions(provider: string, catalog: readonly string[]): ModelOption[] {
  const map = new Map<string, Set<string>>();
  for (const id of catalog) {
    if (provider === "zcode") {
      if (id === "GLM-5.3" || id === "GLM-5.3-Flash") {
        for (const effort of ["low", "high", "max"]) addModelOption(map, id, effort);
      }
      continue;
    }
    const match = provider === "cursor"
      ? /^(.*?)-(none|low|normal|medium|high|xhigh|max)(-fast)?$/i.exec(id)
      : provider === "antigravity"
        ? /^(.*?)-(low|medium|high|max)$/i.exec(id)
        : null;
    if (match) {
      // A fast id is base-high-fast, while base-fast + high would resolve to
      // base-fast-high. Retain the exact fast variant rather than invent it.
      const parent = provider === "cursor" && match[3] ? id : match[1] ?? id;
      const effort = match[2];
      if (effort !== undefined && (provider !== "cursor" || resolveCursorModel(parent, effort.toLowerCase()) === id)) {
        addModelOption(map, parent, effort.toLowerCase());
      }
      if (provider === "cursor") {
        addModelOption(map, id, "");
        if (effort) addModelOption(map, id, effort.toLowerCase());
      }
    } else {
      // Empty means no effort override. Cursor's literal 'none' is a distinct
      // catalog variant, never a substitute for an unspecified effort.
      addModelOption(map, id, "");
    }
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([model, efforts]) => ({
    model,
    efforts: [...efforts].sort((a, b) => {
      const order = ["", "none", "low", "normal", "medium", "high", "xhigh", "max"];
      return order.indexOf(a) - order.indexOf(b);
    }),
  }));
}

function buildConnectionSnippets(configPath: string, scriptPath: string, config: OperatorConfig): { json: string; toml: string } {
  const command = path.resolve(process.execPath);
  const absoluteScript = path.resolve(scriptPath);
  const args = ["--experimental-transform-types", absoluteScript, "stdio", "--config", path.resolve(configPath)];
  const json = JSON.stringify({
    mcpServers: {
      "agent-broker": { command, args },
    },
  }, null, 2);
  const toml = [
    "[mcp_servers.agent_broker]",
    `command = ${JSON.stringify(command)}`,
    `args = ${JSON.stringify(args)}`,
    "",
  ].join("\n");
  void config;
  return { json, toml };
}

function bootstrapHtml(token: string, port: number, configPath: string, scriptPath: string, config: OperatorConfig): string {
  const bootstrap = JSON.stringify({
    token,
    port,
    configPath: path.resolve(configPath),
    snippets: buildConnectionSnippets(configPath, scriptPath, config),
  }).replace(/</g, "\\u003c");
  const html = readFileSync(path.join(UI_DIR, "index.html"), "utf8");
  return html.replace("/*OPERATOR_BOOTSTRAP_JSON*/", () => bootstrap);
}

function fileAsset(name: string): { body: string; type: string } | null {
  const assets: Record<string, string> = {
    "/app.js": "application/javascript; charset=utf-8",
    "/styles.css": "text/css; charset=utf-8",
  };
  const type = assets[name];
  if (!type) return null;
  const expected = path.join(UI_DIR, name.slice(1));
  return { body: readFileSync(expected, "utf8"), type };
}

function parseRevisionBody(body: unknown): { revision: string; config: Record<string, unknown> } {
  if (!isRecord(body) || typeof body.revision !== "string" || !isRecord(body.config)) {
    throw new Error("request must contain config and revision");
  }
  return { revision: body.revision, config: body.config };
}

function startListening(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("operator UI did not receive a TCP address"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

export async function startOperatorUi(options: OperatorUiOptions): Promise<OperatorUiService> {
  const configPath = path.resolve(options.configPath);
  const startup = readRawConfig(configPath);
  const validated = validateRawConfig(configPath, startup.value);
  const token = randomBytes(32).toString("hex");
  const server = createServer();
  let saveChain: Promise<unknown> = Promise.resolve();
  let actualPort = 0;
  const scriptPath = options.scriptPath ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "main.ts");
  const readCatalog = options.readCatalog ?? defaultCatalogReader;
  const initialFolder = startupFolder(configPath, validated);

  server.on("request", (request, response) => {
    void (async () => {
      if (actualPort === 0) {
        sendJson(response, 503, { error: "operator UI is starting" });
        return;
      }
      const pathName = new URL(request.url ?? "/", `http://127.0.0.1:${actualPort}`).pathname;
      if (pathName.startsWith("/api/")) {
        const authError = checkRequest(request, token, actualPort);
        if (authError !== null) {
          sendJson(response, authError, { error: authError === 401 ? "unauthorized" : "forbidden" });
          return;
        }
      } else if (request.headers.host !== `127.0.0.1:${actualPort}`) {
        sendText(response, 403, "forbidden", "text/plain; charset=utf-8");
        return;
      }
      if (request.method === "GET" && pathName === "/") {
        sendText(response, 200, bootstrapHtml(token, actualPort, configPath, scriptPath, validated), "text/html; charset=utf-8");
        return;
      }
      const asset = request.method === "GET" ? fileAsset(pathName) : null;
      if (asset) {
        sendText(response, 200, asset.body, asset.type);
        return;
      }
      if (request.method === "GET" && pathName === "/api/config") {
        try {
          const current = readRawConfig(configPath);
          validateRawConfig(configPath, current.value);
          sendJson(response, 200, { config: current.value, revision: sha256(current.bytes) });
        } catch (error) {
          sendJson(response, 409, { error: safeError(error) });
        }
        return;
      }
      if (request.method === "GET" && pathName === "/api/status") {
        try {
          const current = readRawConfig(configPath);
          const currentConfig = validateRawConfig(configPath, current.value);
          sendJson(response, 200, await statusOperator(currentConfig));
        } catch (error) {
          if (error instanceof DaemonRpcError && error.code === "UNAUTHORIZED") {
            sendJson(response, 403, { error: "forbidden" });
          } else {
            sendJson(response, 409, { error: safeError(error) });
          }
        }
        return;
      }
      if (request.method === "PUT" && pathName === "/api/config") {
        let body: unknown;
        try {
          body = parseJsonBody(await readBody(request));
          const update = parseRevisionBody(body);
          const runSave = async () => {
            const current = readRawConfig(configPath);
            const currentRevision = sha256(current.bytes);
            if (currentRevision !== update.revision) {
              sendJson(response, 409, { error: "stale config revision", revision: currentRevision });
              return;
            }
            validateRawConfig(configPath, update.config);
            const backup = writeConfigAtomically(configPath, current, update.config);
            const next = readRawConfig(configPath);
            sendJson(response, 200, {
              saved: true,
              revision: sha256(next.bytes),
              backup,
              restart_required: true,
              message: "Configuration saved. Restart the operator for new sessions to use it; existing sessions keep their bindings.",
            });
          };
          saveChain = saveChain.then(runSave, runSave);
          await saveChain;
        } catch (error) {
          sendJson(response, error instanceof Error && /exceeds 1 MiB/.test(error.message) ? 413 : 400, { error: safeError(error) });
        }
        return;
      }
      if (request.method === "POST" && pathName === "/api/folders") {
        try {
          const body = parseJsonBody(await readBody(request));
          sendJson(response, 200, await listFolder(body, initialFolder));
        } catch (error) {
          sendJson(response, error instanceof Error && /exceeds 1 MiB/.test(error.message) ? 413 : 400, { error: safeError(error) });
        }
        return;
      }
      if (request.method === "POST" && pathName === "/api/models/refresh") {
        try {
          const body = parseJsonBody(await readBody(request));
          if (!isRecord(body) || typeof body.provider !== "string" || body.provider.length === 0) throw new Error("provider is required");
          const current = readRawConfig(configPath);
          const currentConfig = validateRawConfig(configPath, current.value);
          if (!currentConfig.accounts.some(account => account.provider === body.provider)) throw new Error("provider is not configured");
          const result = await readCatalog(body.provider, currentConfig, configPath);
          sendJson(response, 200, { observation: result, options: buildModelOptions(result.provider, result.models) });
        } catch (error) {
          sendJson(response, 400, { error: safeError(error) });
        }
        return;
      }
      sendJson(response, 404, { error: "not found" });
    })().catch(() => {
      if (!response.headersSent) sendJson(response, 500, { error: "operator UI request failed" });
      else response.destroy();
    });
  });

  try {
    actualPort = await startListening(server, options.port ?? DEFAULT_PORT);
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    url: `http://127.0.0.1:${actualPort}`,
    token,
    port: actualPort,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}
