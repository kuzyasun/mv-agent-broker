/**
 * Per-turn read-only input views (spec §7.1.1, §9.2, §12.6).
 *
 * Broker-managed copies OUTSIDE the writable source tree; immutable for the
 * whole turn (lifetime: turn_until_quiescence); never a writable inode alias
 * to blob storage — bytes are copied, not hardlinked; grants are removed
 * after confirmed quiescence.
 */
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TurnInputManifest, TurnInputEntry } from "./manifest.ts";

const TURN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function assertTurnId(turnId: string): void {
  if (!turnId || !TURN_ID_PATTERN.test(turnId) || turnId === "." || turnId === "..") {
    throw new Error("INVALID_TURN_ID");
  }
}

/**
 * Derives file extension from content type (§7.1.1).
 * text/plain → .txt, application/json → .json, text/markdown → .md,
 * application/x-snapshot-tree-manifest → .json; unknown → no extension.
 */
export function extensionFor(contentType: string): string {
  switch (contentType) {
    case "text/plain":
      return ".txt";
    case "application/json":
    case "application/x-snapshot-tree-manifest":
      return ".json";
    case "text/markdown":
      return ".md";
    default:
      return "";
  }
}

export interface InputViewStore {
  /** Materialize all read_only_path inputs of a manifest under a per-turn directory. Returns the per-turn root. Throws Error("INPUT_VIEW_EXISTS") if the turn directory already exists. */
  materialize(manifest: TurnInputManifest, readBlob: (contentHash: string) => Uint8Array): { root: string; files: string[] };
  /** The per-turn directory path for a turn (does not have to exist). */
  turnRoot(turnId: string): string;
  /** Remove the per-turn directory after quiescence. Missing dir is a no-op. */
  cleanup(turnId: string): void;
  /** Whether the turn's view directory exists. */
  exists(turnId: string): boolean;
}

export function openInputViewStore(rootDir: string): InputViewStore {
  const turnRoot = (turnId: string): string => {
    assertTurnId(turnId);
    return path.join(rootDir, turnId);
  };

  return {
    turnRoot,

    materialize(manifest: TurnInputManifest, readBlob: (contentHash: string) => Uint8Array): { root: string; files: string[] } {
      const root = turnRoot(manifest.turn_id);
      if (existsSync(root)) {
        throw new Error("INPUT_VIEW_EXISTS");
      }
      mkdirSync(root, { recursive: true });

      const files: string[] = [];
      for (const entry of manifest.inputs) {
        if (entry.delivery !== "read_only_path") {
          continue;
        }

        // Layout: <rootDir>/<turnId>/<input_id><ext> (§7.1.1).
        const ext = extensionFor(entry.content_type);
        const expectedTarget = path.join(root, `${entry.input_id}${ext}`);
        const normalizedBinding = path.normalize(entry.binding);
        const normalizedExpected = path.normalize(expectedTarget);

        // The materialized file path MUST equal entry.binding for read_only_path entries (§7.1.1).
        if (entry.binding !== expectedTarget && normalizedBinding !== normalizedExpected) {
          throw new Error(`Input view binding mismatch for ${entry.input_id}: expected ${expectedTarget}, got ${entry.binding}`);
        }
        if (!normalizedBinding.startsWith(path.normalize(root) + path.sep)) {
          throw new Error(`Input view outside turn root: ${entry.binding}`);
        }

        const target = entry.binding;
        if (existsSync(target)) {
          throw new Error("INPUT_VIEW_EXISTS");
        }

        const bytes = readBlob(entry.content_hash);
        // Atomic publish: write to a temp sibling file then renameSync (§9.2: copy, never hardlink/symlink).
        const tmp = `${target}.tmp-${manifest.turn_id}`;
        try {
          writeFileSync(tmp, bytes);
          if (existsSync(target)) {
            throw new Error("INPUT_VIEW_EXISTS");
          }
          renameSync(tmp, target);
        } finally {
          if (existsSync(tmp)) {
            rmSync(tmp, { force: true });
          }
        }

        // Best-effort per-file read-only mark (defense-in-depth, §12.6):
        // a 0o500 directory alone does not block in-place writes on POSIX.
        try {
          chmodSync(target, 0o444);
        } catch {
          /* Windows / unsupported FS: not an error */
        }

        files.push(target);
      }

      // Best-effort POSIX read-only marking (§7.1.1, §9.2); enforcement metadata lives in the manifest.
      try {
        chmodSync(root, 0o500);
      } catch {
        /* Windows / unsupported filesystem: not an error */
      }

      return { root, files };
    },

    cleanup(turnId: string): void {
      const root = turnRoot(turnId);
      if (!existsSync(root)) {
        return;
      }
      try {
        chmodSync(root, 0o700);
      } catch {
        /* Best effort write restoration before removal */
      }
      rmSync(root, { recursive: true, force: true });
    },

    exists(turnId: string): boolean {
      return existsSync(turnRoot(turnId));
    },
  };
}
