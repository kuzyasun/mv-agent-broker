/**
 * Content-addressed blob store (spec §14.1): immutable file blobs addressed
 * by `(project_id, SHA-256(content))`, reused across snapshot manifests of
 * one project. Cross-project reads are impossible by address layout.
 * Physical-layout reuse never extends ACL (same project only).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { sha256Hex } from "../shared/ids.ts";

export interface BlobStore {
  /** Write bytes; dedup by (projectId, hash). Returns hash + size. */
  write(projectId: string, content: Uint8Array | string): { hash: string; size: number; deduplicated: boolean };
  /** Read blob bytes; throws Error("BLOB_NOT_FOUND") if absent. */
  read(projectId: string, hash: string): Uint8Array;
  has(projectId: string, hash: string): boolean;
  sizeOf(projectId: string, hash: string): number | null;
  /** Delete a blob; throws Error("BLOB_NOT_FOUND") if absent. */
  delete(projectId: string, hash: string): void;
}

const ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function assertIds(projectId: string, hash: string): void {
  // Reject dot-only/dot-prefixed ids: "." and ".." would escape the root.
  const safeProject =
    ID_PATTERN.test(projectId) && !projectId.startsWith(".") && projectId !== "..";
  if (!safeProject || !HASH_PATTERN.test(hash)) {
    throw new Error("INVALID_BLOB_ID");
  }
}

export function openBlobStore(rootDir: string): BlobStore {
  const blobPath = (projectId: string, hash: string): string => {
    assertIds(projectId, hash);
    return path.join(rootDir, projectId, hash.slice(0, 2), hash);
  };

  return {
    write(projectId, content) {
      const hash = sha256Hex(content);
      const size = typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.byteLength;
      const target = blobPath(projectId, hash);
      if (existsSync(target)) {
        return { hash, size, deduplicated: true };
      }
      mkdirSync(path.dirname(target), { recursive: true });
      // Atomic-ish publish: write a temp sibling then rename over the target.
      const tmp = `${target}.tmp-${randomUUID()}`;
      writeFileSync(tmp, content);
      try {
        renameSync(tmp, target);
      } catch (e) {
        rmSync(tmp, { force: true });
        if (existsSync(target)) return { hash, size, deduplicated: true };
        throw e;
      }
      return { hash, size, deduplicated: false };
    },

    read(projectId, hash) {
      const target = blobPath(projectId, hash);
      if (!existsSync(target)) throw new Error("BLOB_NOT_FOUND");
      return new Uint8Array(readFileSync(target));
    },

    has(projectId, hash) {
      return existsSync(blobPath(projectId, hash));
    },

    sizeOf(projectId, hash) {
      const target = blobPath(projectId, hash);
      if (!existsSync(target)) return null;
      return statSync(target).size;
    },

    delete(projectId, hash) {
      const target = blobPath(projectId, hash);
      if (!existsSync(target)) throw new Error("BLOB_NOT_FOUND");
      rmSync(target);
    },
  };
}
