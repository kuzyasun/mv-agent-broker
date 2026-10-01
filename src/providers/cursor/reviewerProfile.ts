/**
 * Cursor reviewer configuration helper.
 *
 * Produces candidate native configuration for Cursor reviewer turns (§13.2).
 * Validates workspace and exact broker read-only input paths before dispatch.
 */
import path from "node:path";
import { BrokerError } from "../../shared/errors.ts";

export interface CursorReviewerConfig {
  version: number;
  editor: {
    vimMode: boolean;
  };
  approvalMode: string;
  sandbox: {
    readBoundary: "workspace";
  };
  permissions: {
    allow: string[];
    deny: string[];
  };
}

export interface ReviewerProfileParams {
  workspace_path: string | null | undefined;
  read_only_input_paths?: readonly string[];
}

export function validateCanonicalPath(rawPath: unknown, fieldName = "path"): string {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new BrokerError("POLICY_UNSUPPORTED", `${fieldName} must be a non-empty string.`, { executionStarted: false });
  }

  const p = rawPath;

  if (p.includes("\0")) {
    throw new BrokerError("POLICY_UNSUPPORTED", `${fieldName} contains forbidden NUL character.`, { executionStarted: false });
  }

  if (p.includes("\r") || p.includes("\n")) {
    throw new BrokerError("POLICY_UNSUPPORTED", `${fieldName} contains forbidden newline characters.`, { executionStarted: false });
  }

  if (/[*?\[\]{}]/.test(p)) {
    throw new BrokerError("POLICY_UNSUPPORTED", `${fieldName} contains forbidden wildcard characters: ${p}.`, { executionStarted: false });
  }

  if (/[();"`,]/.test(p)) {
    throw new BrokerError("POLICY_UNSUPPORTED", `${fieldName} contains forbidden permission-token injection characters: ${p}.`, { executionStarted: false });
  }

  const isAbs = /^[a-z]:[\\/]/i.test(p) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(p) || path.posix.isAbsolute(p);
  if (!isAbs) {
    throw new BrokerError("POLICY_UNSUPPORTED", `${fieldName} must be an absolute path: ${p}.`, { executionStarted: false });
  }

  const segments = p.split(/[\\/]/);
  if (segments.some(seg => seg === "." || seg === "..")) {
    throw new BrokerError("POLICY_UNSUPPORTED", `${fieldName} must be canonical and cannot contain relative traversal segments: ${p}.`, { executionStarted: false });
  }

  return p;
}

export function buildCursorReviewerConfig(
  inputOrWorkspace: ReviewerProfileParams | string | null | undefined,
  maybeInputs?: readonly string[],
): CursorReviewerConfig {
  let workspaceRaw: string | null | undefined;
  let inputsRaw: readonly string[] | undefined;

  if (
    typeof inputOrWorkspace === "object" &&
    inputOrWorkspace !== null &&
    ("workspace_path" in inputOrWorkspace || "read_only_input_paths" in inputOrWorkspace)
  ) {
    workspaceRaw = inputOrWorkspace.workspace_path;
    inputsRaw = inputOrWorkspace.read_only_input_paths;
  } else {
    workspaceRaw = inputOrWorkspace as string | null | undefined;
    inputsRaw = maybeInputs;
  }

  if (typeof workspaceRaw !== "string" || !workspaceRaw.trim()) {
    throw new BrokerError("POLICY_UNSUPPORTED", "Cursor reviewer requires an explicit workspace_path.", { executionStarted: false });
  }

  const validatedWorkspace = validateCanonicalPath(workspaceRaw, "workspace_path");

  const validatedInputs: string[] = [];
  if (inputsRaw !== null && inputsRaw !== undefined) {
    if (!Array.isArray(inputsRaw)) {
      throw new BrokerError("POLICY_UNSUPPORTED", "read_only_input_paths must be an array of paths.", { executionStarted: false });
    }
    for (const item of inputsRaw) {
      if (typeof item !== "string") {
        throw new BrokerError("POLICY_UNSUPPORTED", "read_only_input_paths elements must be strings.", { executionStarted: false });
      }
      const validated = validateCanonicalPath(item, "read_only_input_paths");
      validatedInputs.push(validated);
    }
  }

  const allow: string[] = [`Read(${validatedWorkspace})`];
  for (const item of validatedInputs) {
    const entry = `Read(${item})`;
    if (!allow.includes(entry)) {
      allow.push(entry);
    }
  }

  return {
    version: 1,
    editor: {
      vimMode: false,
    },
    approvalMode: "allowlist",
    sandbox: {
      readBoundary: "workspace",
    },
    permissions: {
      allow,
      deny: [
        "Write(**)",
        "Shell(*)",
        "WebFetch(*)",
        "Mcp(*:*)",
      ],
    },
  };
}

export const buildCursorReviewerProfile = buildCursorReviewerConfig;
export const createCursorReviewerProfile = buildCursorReviewerConfig;
