import type {
  BootstrapData,
  CatalogRefreshResult,
  FolderEntry,
  OperatorConfig,
  OperatorStatus,
  StoragePreview,
  TurnErrorDetail,
} from "./types.ts";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly data: Record<string, unknown>,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

declare global {
  interface Window {
    __OPERATOR_BOOTSTRAP__?: BootstrapData;
  }
}

let cachedBootstrap: BootstrapData | null = null;

export function getBootstrap(): BootstrapData {
  if (cachedBootstrap) return cachedBootstrap;
  if (typeof window !== "undefined" && window.__OPERATOR_BOOTSTRAP__) {
    cachedBootstrap = window.__OPERATOR_BOOTSTRAP__;
    return cachedBootstrap;
  }
  return {
    token: "",
    port: 0,
    configPath: "",
    snippets: { json: "", toml: "" },
    display: { locale: "en-US", timeZone: "UTC", hourCycle: null },
  };
}

export function setBootstrapForTesting(data: BootstrapData | null): void {
  cachedBootstrap = data;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const bootstrap = getBootstrap();
  const headers = new Headers(options.headers);
  if (bootstrap.token) {
    headers.set("x-operator-token", bootstrap.token);
  }
  if (options.body && typeof options.body === "string" && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(path, { ...options, headers });
  let data: Record<string, unknown> = {};
  const text = await response.text();
  if (text.length > 0) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const errorMsg =
      typeof data.error === "string" ? data.error : `Request failed with status ${response.status}`;
    throw new ApiError(response.status, data, errorMsg);
  }

  return data as unknown as T;
}

export async function fetchConfig(): Promise<{
  config: OperatorConfig;
  revision: string;
  snippets: { json: string; toml: string };
  display: BootstrapData["display"];
}> {
  return request("/api/config");
}

export async function saveConfig(
  config: OperatorConfig,
  revision: string,
): Promise<{
  saved: boolean;
  revision: string;
  backup: string;
  snippets: { json: string; toml: string };
  message: string;
}> {
  return request("/api/config", {
    method: "PUT",
    body: JSON.stringify({ revision, config }),
  });
}

export async function restartDaemon(
  revision: string,
): Promise<{
  restarted: boolean;
  revision: string;
  message: string;
  [key: string]: unknown;
}> {
  return request("/api/restart", {
    method: "POST",
    body: JSON.stringify({ revision }),
  });
}

export async function fetchStatus(): Promise<OperatorStatus> {
  return request("/api/status");
}

export async function fetchTurnError(turnId: string): Promise<TurnErrorDetail> {
  return request(`/api/turn-errors/${encodeURIComponent(turnId)}`);
}

export async function clearQuotaPause(
  provider: string,
  quotaScopeId: string,
): Promise<{ cleared: boolean }> {
  return request("/api/quota-pause/clear", {
    method: "POST",
    body: JSON.stringify({ provider, quota_scope_id: quotaScopeId }),
  });
}

export async function fetchFolders(folderPath?: string): Promise<FolderEntry> {
  return request("/api/folders", {
    method: "POST",
    body: JSON.stringify(folderPath ? { path: folderPath } : {}),
  });
}

export async function refreshCatalog(provider: string): Promise<CatalogRefreshResult> {
  return request("/api/models/refresh", {
    method: "POST",
    body: JSON.stringify({ provider }),
  });
}

export async function previewStorage(
  projectId: string,
  retentionDays?: number,
): Promise<StoragePreview> {
  return request("/api/storage/preview", {
    method: "POST",
    body: JSON.stringify(
      retentionDays !== undefined ? { project_id: projectId, retention_days: retentionDays } : { project_id: projectId },
    ),
  });
}

export async function executeStorage(
  projectId: string,
  previewToken: string,
  retentionDays?: number,
): Promise<{
  executed: boolean;
  deleted_blob_count: number;
  deleted_blob_bytes: number;
  [key: string]: unknown;
}> {
  return request("/api/storage/execute", {
    method: "POST",
    body: JSON.stringify({
      project_id: projectId,
      preview_token: previewToken,
      ...(retentionDays !== undefined ? { retention_days: retentionDays } : {}),
    }),
  });
}
