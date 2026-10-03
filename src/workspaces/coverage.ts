/**
 * Versioned source-classification contract (spec §8.5, §8.7, §9.1).
 * Classification is part of the policy/coverage contract, decided BEFORE the
 * agent runs — never a post-hoc judgment about what the agent did.
 */
import { sha256Hex } from "../shared/ids.ts";

export const COVERAGE_CONTRACT_SEMANTICS = "coverage-contract:v1";

export interface CoverageConfig {
  source_prefixes: string[];
  non_source_prefixes: string[];
  excluded_prefixes: string[];
}

export type PathCategory = "source" | "non_source_output" | "excluded" | "protected_or_undeclared";

export class CoverageError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "CoverageError";
  }
}

/**
 * Normalize to a POSIX-style relative path; reject traversal/absolute.
 * This is the ACTUAL file-path normalizer: unlike a policy prefix, a real
 * relative file path can never be the project root itself.
 */
export function normalizeRelPath(p: string): string {
  const raw = p.replace(/\\/g, "/");
  // Absolute inputs are rejected BEFORE any stripping (§8.5).
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
    throw new CoverageError(`Absolute path not allowed: ${p}`, "INVALID_PATH");
  }
  let posix = raw;
  while (posix.startsWith("./")) posix = posix.slice(2); // strip repeatedly
  posix = posix.replace(/^\/+/, "");
  if (posix.length === 0) throw new CoverageError(`Empty path`, "INVALID_PATH");
  const segments = posix.split("/");
  if (segments.some((s) => s === ".." || s === "." || s.length === 0)) {
    throw new CoverageError(`Traversal, dot or empty segment not allowed: ${p}`, "INVALID_PATH");
  }
  return segments.join("/");
}

/** Canonical prefix for the whole project root (operator default grant). */
export const PROJECT_ROOT_PREFIX = ".";

/**
 * Normalize a POLICY prefix (coverage selectors, write scopes): backslashes
 * and leading "./" collapse; the lone project-root prefix "." is allowed and
 * canonical. Absolute and traversal inputs are still rejected — a prefix is a
 * policy statement, never a concrete file location. Actual file paths must go
 * through normalizeRelPath, which keeps rejecting ".".
 */
export function normalizePolicyPrefix(p: string): string {
  const raw = p.replace(/\\/g, "/");
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) {
    throw new CoverageError(`Absolute path not allowed: ${p}`, "INVALID_PATH");
  }
  if (raw.trim().length === 0) throw new CoverageError(`Empty path`, "INVALID_PATH");
  let posix = raw;
  while (posix.startsWith("./")) posix = posix.slice(2); // strip repeatedly
  posix = posix.replace(/^\/+/, "");
  if (posix.length === 0 || posix === ".") return PROJECT_ROOT_PREFIX;
  const segments = posix.split("/");
  if (segments.some((s) => s === ".." || s === "." || s.length === 0)) {
    throw new CoverageError(`Traversal, dot or empty segment not allowed: ${p}`, "INVALID_PATH");
  }
  return segments.join("/");
}

/** Normalize a policy prefix list; null when any entry is invalid (fail-closed). */
export function normalizePrefixList(list: string[]): string[] | null {
  try {
    return list.map(normalizePolicyPrefix);
  } catch {
    return null;
  }
}

/** Tri-state parse of a policy profile's write_scope (§8.1, §8.7). */
export type PolicyWriteScope =
  | { kind: "declared"; prefixes: string[] }
  | { kind: "absent" }
  | { kind: "invalid"; reason: string };

/**
 * Distinguishes "no write scope declared" (valid, nothing permitted) from
 * "declared but unreadable/invalid" (operator config error — admission must
 * reject before inference rather than fail after the run, §8.7).
 */
export function parsePolicyWriteScope(policyConfigJson: string): PolicyWriteScope {
  let parsed: { write_scope?: unknown };
  try {
    parsed = JSON.parse(policyConfigJson) as { write_scope?: unknown };
  } catch {
    return { kind: "invalid", reason: "policy config is not valid JSON" };
  }
  if (parsed.write_scope === undefined) return { kind: "absent" };
  if (!Array.isArray(parsed.write_scope) || parsed.write_scope.some((x) => typeof x !== "string")) {
    return { kind: "invalid", reason: "write_scope must be an array of relative path prefixes" };
  }
  const normalized = normalizePrefixList(parsed.write_scope as string[]);
  if (!normalized) return { kind: "invalid", reason: "write_scope contains invalid path prefixes" };
  return { kind: "declared", prefixes: normalized };
}

function prefixSegments(prefix: string): string[] {
  return prefix.split("/").filter((s) => s.length > 0);
}

/**
 * Prefix match by path COMPONENTS (§8.5): `src/parser` matches
 * `src/parser/x.c` and `src/parser` itself, but NOT `src/parser-old/x.c`.
 * The project-root prefix "." matches every real relative path.
 */
export function matchesPrefix(relPath: string, prefix: string): boolean {
  if (prefix === PROJECT_ROOT_PREFIX) return relPath.length > 0;
  const pathSegs = relPath.split("/");
  const prefixSegs = prefixSegments(prefix);
  if (prefixSegs.length === 0) return false;
  if (pathSegs.length < prefixSegs.length) return false;
  return prefixSegs.every((seg, i) => pathSegs[i] === seg);
}

/** Classification order: excluded → non-source → source → protected. */
export function classifyPath(relPath: string, config: CoverageConfig): PathCategory {
  const normalized = relPath.includes("\\") || relPath.startsWith("./") ? normalizeRelPath(relPath) : relPath;
  for (const p of config.excluded_prefixes) if (matchesPrefix(normalized, p)) return "excluded";
  for (const p of config.non_source_prefixes) if (matchesPrefix(normalized, p)) return "non_source_output";
  for (const p of config.source_prefixes) if (matchesPrefix(normalized, p)) return "source";
  return "protected_or_undeclared";
}

function isInside(childPrefix: string, parentPrefix: string): boolean {
  return childPrefix !== parentPrefix && matchesPrefix(childPrefix, parentPrefix);
}

/**
 * Validate a config (§8.7): source and non-source writable sets must be
 * contradiction-free. Overlapping or nested prefixes of different classes
 * are rejected — never silently resolved in favor of exclusion. The one
 * intentional exception: explicit exclusions may carve generated/broker
 * folders out of the whole-project root source prefix "." (excluded wins by
 * classification order); any other overlap stays a config error.
 */
export function validateCoverageConfig(config: CoverageConfig): void {
  const groups: Array<["source_prefixes" | "non_source_prefixes" | "excluded_prefixes", string[]]> = [
    ["source_prefixes", config.source_prefixes],
    ["non_source_prefixes", config.non_source_prefixes],
    ["excluded_prefixes", config.excluded_prefixes],
  ];
  for (const [name, list] of groups) {
    const seen = new Set<string>();
    for (const raw of list) {
      let normalized: string;
      try {
        normalized = normalizePolicyPrefix(raw);
      } catch (e) {
        throw new CoverageError(`${name}: ${(e as CoverageError).message}`, "INVALID_PREFIX");
      }
      if (seen.has(normalized)) {
        throw new CoverageError(`${name}: duplicate prefix ${normalized}`, "DUPLICATE_PREFIX");
      }
      seen.add(normalized);
    }
  }
  const src = config.source_prefixes.map(normalizePolicyPrefix);
  const non = config.non_source_prefixes.map(normalizePolicyPrefix);
  const excl = config.excluded_prefixes.map(normalizePolicyPrefix);
  for (const a of [...src, ...non]) {
    for (const e of excl) {
      if (a === e || isInside(a, e) || isInside(e, a)) {
        // Root exclusions intentionally override whole-project source; an
        // exclusion of "." itself would void the root source entirely.
        if (a === PROJECT_ROOT_PREFIX && src.includes(a) && e !== PROJECT_ROOT_PREFIX) continue;
        throw new CoverageError(`Prefix '${a}' conflicts with exclusion '${e}'`, "PREFIX_OVERLAP");
      }
    }
  }
  for (const s of src) {
    for (const n of non) {
      if (s === n || isInside(s, n) || isInside(n, s)) {
        throw new CoverageError(`Source '${s}' overlaps non-source '${n}'`, "PREFIX_OVERLAP");
      }
    }
  }
}

/**
 * Stable contract hash over the canonical RULES (classification semantics,
 * prefix sets, exclusions) — never over a concrete file list (§5.4).
 */
export function coverageContractHash(config: CoverageConfig): string {
  const canonical = {
    semantics: COVERAGE_CONTRACT_SEMANTICS,
    source_prefixes: [...config.source_prefixes].map(normalizePolicyPrefix).sort(),
    non_source_prefixes: [...config.non_source_prefixes].map(normalizePolicyPrefix).sort(),
    excluded_prefixes: [...config.excluded_prefixes].map(normalizePolicyPrefix).sort(),
  };
  return sha256Hex(JSON.stringify(canonical));
}

/**
 * §8.7: the coverage contract must cover the ENTIRE allowed source write
 * set, including files that do not exist yet. Returns uncovered prefixes.
 * The root source prefix "." covers every write scope inside the project.
 */
export function uncoveredWriteScope(writeScope: string[], config: CoverageConfig): string[] {
  const sourcePrefixes = config.source_prefixes.map(normalizePolicyPrefix);
  return writeScope
    .filter((w) => {
      const ws = normalizePolicyPrefix(w);
      return !sourcePrefixes.some((s) => ws === s || isInside(ws, s));
    })
    .map((w) => normalizePolicyPrefix(w));
}
