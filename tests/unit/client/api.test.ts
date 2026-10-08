// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshCatalog, setBootstrapForTesting } from "../../../src/operator/ui/client/api.ts";

describe("operator API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setBootstrapForTesting(null);
  });

  it("returns the catalogue observation and server-provided model effort options", async () => {
    const envelope = {
      observation: {
        provider: "antigravity",
        models: ["gemini-3.8-flash-low", "gemini-3.8-flash-high"],
        observed_at: 42,
        source: "cli_metadata_probe",
        detail: null,
      },
      options: [{ model: "gemini-3.8-flash", efforts: ["low", "high"] }],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    setBootstrapForTesting({
      token: "test-token",
      port: 4319,
      configPath: "",
      snippets: { json: "", toml: "" },
      display: { locale: "en-US", timeZone: "UTC", hourCycle: null },
    });

    const result = await refreshCatalog("antigravity");

    expect(result).toEqual(envelope);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/models/refresh");
    expect(request.method).toBe("POST");
    expect(JSON.parse(String(request.body))).toEqual({ provider: "antigravity" });
    expect(new Headers(request.headers).get("x-operator-token")).toBe("test-token");
  });
});
