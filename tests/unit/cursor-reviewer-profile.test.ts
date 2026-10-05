import { describe, expect, it } from "vitest";
import {
  buildCursorReviewerConfig,
  buildCursorReviewerProfile,
  createCursorReviewerProfile,
  validateCanonicalPath,
} from "../../src/providers/cursor/reviewerProfile.ts";
import { BrokerError } from "../../src/shared/errors.ts";

describe("Cursor reviewer profile helper", () => {
  describe("validateCanonicalPath", () => {
    it("accepts valid canonical absolute paths with spaces and slashes", () => {
      expect(validateCanonicalPath("C:\\my workspace\\project")).toBe("C:\\my workspace\\project");
      expect(validateCanonicalPath("C:\\code\\test")).toBe("C:\\code\\test");
      expect(validateCanonicalPath("/var/log/app folder")).toBe("/var/log/app folder");
      expect(validateCanonicalPath("/home/user/repo")).toBe("/home/user/repo");
      expect(validateCanonicalPath("/repo/README.md")).toBe("/repo/README.md");
      expect(validateCanonicalPath("/repo/Shell helpers ")).toBe("/repo/Shell helpers ");
    });

    it("rejects non-string or empty path with POLICY_UNSUPPORTED", () => {
      expect(() => validateCanonicalPath(null)).toThrow(BrokerError);
      expect(() => validateCanonicalPath(undefined)).toThrow(BrokerError);
      expect(() => validateCanonicalPath("")).toThrow(BrokerError);
      expect(() => validateCanonicalPath("   ")).toThrow(BrokerError);
      try {
        validateCanonicalPath("");
      } catch (err) {
        expect((err as BrokerError).code).toBe("POLICY_UNSUPPORTED");
        expect((err as BrokerError).executionStarted).toBe(false);
      }
    });

    it("rejects relative paths with POLICY_UNSUPPORTED", () => {
      const relatives = ["relative/path", "./local", "../parent", "file.txt"];
      for (const p of relatives) {
        expect(() => validateCanonicalPath(p)).toThrow(BrokerError);
        try {
          validateCanonicalPath(p);
        } catch (err) {
          expect((err as BrokerError).code).toBe("POLICY_UNSUPPORTED");
          expect((err as BrokerError).executionStarted).toBe(false);
        }
      }
    });

    it("rejects relative traversal segments with POLICY_UNSUPPORTED", () => {
      const traversals = [
        "C:\\foo\\..\\bar",
        "C:\\foo\\.\\bar",
        "/var/app/../other",
        "/var/app/./current",
      ];
      for (const p of traversals) {
        expect(() => validateCanonicalPath(p)).toThrow(BrokerError);
        try {
          validateCanonicalPath(p);
        } catch (err) {
          expect((err as BrokerError).code).toBe("POLICY_UNSUPPORTED");
          expect((err as BrokerError).executionStarted).toBe(false);
        }
      }
    });

    it("rejects NUL and newline characters with POLICY_UNSUPPORTED", () => {
      const dangerous = [
        "C:\\valid\\path\0injection",
        "C:\\valid\\path\ninjection",
        "C:\\valid\\path\rinjection",
        "/valid/path\0test",
        "/valid/path\ntest",
      ];
      for (const p of dangerous) {
        expect(() => validateCanonicalPath(p)).toThrow(BrokerError);
        try {
          validateCanonicalPath(p);
        } catch (err) {
          expect((err as BrokerError).code).toBe("POLICY_UNSUPPORTED");
          expect((err as BrokerError).executionStarted).toBe(false);
        }
      }
    });

    it("rejects wildcards with POLICY_UNSUPPORTED", () => {
      const wildcards = [
        "C:\\workspace\\*",
        "C:\\workspace\\**",
        "C:\\workspace\\file?.txt",
        "/var/app/*",
        "/var/app/[ab]",
        "/var/app/{one,two}",
      ];
      for (const p of wildcards) {
        expect(() => validateCanonicalPath(p)).toThrow(BrokerError);
        try {
          validateCanonicalPath(p);
        } catch (err) {
          expect((err as BrokerError).code).toBe("POLICY_UNSUPPORTED");
          expect((err as BrokerError).executionStarted).toBe(false);
        }
      }
    });

    it("rejects permission token injection characters with POLICY_UNSUPPORTED", () => {
      const injections = [
        "C:\\workspace), Write(**",
        "C:\\workspace); Shell(*)",
        "C:\\workspace\" Read(**)",
        "C:\\workspace, Read(**)",
        "C:\\workspace(evil)",
        "Read(**)",
        "Write(**)",
        "Shell(*)",
        "Mcp(*:*)",
      ];
      for (const p of injections) {
        expect(() => validateCanonicalPath(p)).toThrow(BrokerError);
        try {
          validateCanonicalPath(p);
        } catch (err) {
          expect((err as BrokerError).code).toBe("POLICY_UNSUPPORTED");
          expect((err as BrokerError).executionStarted).toBe(false);
        }
      }
    });
  });

  describe("buildCursorReviewerConfig", () => {
    it("fails with POLICY_UNSUPPORTED when workspace_path is missing or empty", () => {
      expect(() => buildCursorReviewerConfig({ workspace_path: null })).toThrow(BrokerError);
      expect(() => buildCursorReviewerConfig({ workspace_path: "" })).toThrow(BrokerError);
      expect(() => buildCursorReviewerConfig({ workspace_path: "   " })).toThrow(BrokerError);
      expect(() => buildCursorReviewerConfig(null)).toThrow(BrokerError);
      expect(() => buildCursorReviewerConfig("")).toThrow(BrokerError);
      try {
        buildCursorReviewerConfig({ workspace_path: null });
      } catch (err) {
        expect((err as BrokerError).code).toBe("POLICY_UNSUPPORTED");
        expect((err as BrokerError).executionStarted).toBe(false);
      }
    });

    it("builds candidate native configuration with workspace allowance only", () => {
      const config = buildCursorReviewerConfig({
        workspace_path: "C:\\my workspace\\code",
      });
      expect(config).toEqual({
        version: 1,
        editor: {
          vimMode: false,
        },
        approvalMode: "allowlist",
        sandbox: {
          readBoundary: "workspace",
        },
        permissions: {
          allow: ["Read(C:\\my workspace\\code)"],
          deny: [
            "Write(**)",
            "Shell(*)",
            "WebFetch(*)",
            "Mcp(*:*)",
          ],
        },
      });
    });

    it("builds candidate native configuration with workspace and input paths allowances", () => {
      const config = buildCursorReviewerConfig({
        workspace_path: "C:\\project\\src",
        read_only_input_paths: [
          "C:\\broker inputs\\manifest.json",
          "C:\\broker inputs\\diff.patch",
        ],
      });
      expect(config).toEqual({
        version: 1,
        editor: {
          vimMode: false,
        },
        approvalMode: "allowlist",
        sandbox: {
          readBoundary: "workspace",
        },
        permissions: {
          allow: [
            "Read(C:\\project\\src)",
            "Read(C:\\broker inputs\\manifest.json)",
            "Read(C:\\broker inputs\\diff.patch)",
          ],
          deny: [
            "Write(**)",
            "Shell(*)",
            "WebFetch(*)",
            "Mcp(*:*)",
          ],
        },
      });
    });

    it("deduplicates identical allowances starting with workspace", () => {
      const config = buildCursorReviewerConfig({
        workspace_path: "C:\\project\\src",
        read_only_input_paths: [
          "C:\\project\\src",
          "C:\\broker inputs\\file.txt",
          "C:\\broker inputs\\file.txt",
        ],
      });
      expect(config.permissions.allow).toEqual([
        "Read(C:\\project\\src)",
        "Read(C:\\broker inputs\\file.txt)",
      ]);
    });

    it("rejects dangerous input paths with POLICY_UNSUPPORTED without creating grants", () => {
      expect(() => buildCursorReviewerConfig({
        workspace_path: "C:\\project\\src",
        read_only_input_paths: ["C:\\inputs\\*"],
      })).toThrow(BrokerError);

      expect(() => buildCursorReviewerConfig({
        workspace_path: "C:\\project\\src",
        read_only_input_paths: ["relative/input"],
      })).toThrow(BrokerError);

      expect(() => buildCursorReviewerConfig({
        workspace_path: "C:\\project\\src",
        read_only_input_paths: ["C:\\inputs\\evil), Write(**"],
      })).toThrow(BrokerError);
    });

    it("supports positional argument format and aliases identically", () => {
      const cfg1 = buildCursorReviewerConfig("C:\\workspace", ["C:\\input1"]);
      const cfg2 = buildCursorReviewerProfile("C:\\workspace", ["C:\\input1"]);
      const cfg3 = createCursorReviewerProfile("C:\\workspace", ["C:\\input1"]);
      expect(cfg1).toEqual(cfg2);
      expect(cfg1).toEqual(cfg3);
      expect(cfg1.permissions.allow).toEqual(["Read(C:\\workspace)", "Read(C:\\input1)"]);
    });

    it("retains safe compatibility when read_only_input_paths is empty or undefined", () => {
      const cfg1 = buildCursorReviewerConfig("C:\\workspace", []);
      const cfg2 = buildCursorReviewerConfig("C:\\workspace", undefined);
      expect(cfg1.permissions.allow).toEqual(["Read(C:\\workspace)"]);
      expect(cfg2.permissions.allow).toEqual(["Read(C:\\workspace)"]);
    });

    it("opts into read-only git by allowing Shell(git) and dropping the blanket Shell deny", () => {
      const config = buildCursorReviewerConfig({
        workspace_path: "C:\\project\\src",
        allow_read_only_git: true,
      });
      expect(config.permissions.allow).toEqual(["Read(C:\\project\\src)", "Shell(git)"]);
      // Native deny beats allow, so the blanket Shell(*) deny must yield.
      expect(config.permissions.deny).toEqual(["Write(**)", "WebFetch(*)", "Mcp(*:*)"]);
    });

    it("keeps the tool-free deny list without the opt-in (explicit false and default)", () => {
      const explicitFalse = buildCursorReviewerConfig({
        workspace_path: "C:\\project\\src",
        allow_read_only_git: false,
      });
      const byDefault = buildCursorReviewerConfig({ workspace_path: "C:\\project\\src" });
      for (const config of [explicitFalse, byDefault]) {
        expect(config.permissions.allow).toEqual(["Read(C:\\project\\src)"]);
        expect(config.permissions.deny).toEqual(["Write(**)", "Shell(*)", "WebFetch(*)", "Mcp(*:*)"]);
      }
    });

    it("combines the git opt-in with input path allowances", () => {
      const config = buildCursorReviewerConfig({
        workspace_path: "C:\\project\\src",
        read_only_input_paths: ["C:\\broker inputs\\diff.patch"],
        allow_read_only_git: true,
      });
      expect(config.permissions.allow).toEqual([
        "Read(C:\\project\\src)",
        "Read(C:\\broker inputs\\diff.patch)",
        "Shell(git)",
      ]);
    });
  });
});
