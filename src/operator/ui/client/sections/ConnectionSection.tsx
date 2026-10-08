import { useSignal } from "@preact/signals";
import type { JSX } from "preact";
import { connectionSnippets, setActionMessage } from "../store.ts";
import { CopyIcon } from "../components/Icons.tsx";

export function ConnectionSection(): JSX.Element {
  const snippets = connectionSnippets.value;
  const copiedJson = useSignal<boolean>(false);
  const copiedToml = useSignal<boolean>(false);

  const copyToClipboard = async (text: string, isJson: boolean) => {
    try {
      await navigator.clipboard.writeText(text);
      if (isJson) {
        copiedJson.value = true;
        setTimeout(() => {
          copiedJson.value = false;
        }, 2000);
      } else {
        copiedToml.value = true;
        setTimeout(() => {
          copiedToml.value = false;
        }, 2000);
      }
      setActionMessage(
        `${isJson ? "MCP JSON" : "Codex TOML"} copied to clipboard.`,
        "success",
        2000,
      );
    } catch {
      setActionMessage("Failed to copy to clipboard.", "error", 3000);
    }
  };

  return (
    <div className="flex-1 p-4 bg-[#f8f9fa] overflow-y-auto space-y-4">
      <div className="border border-[#c4c5d7] bg-white p-4 space-y-4 max-w-3xl">
        <div className="border-b border-[#e5e7eb] pb-2">
          <h2 className="text-base font-semibold text-[#141b2b]">Client Connection Snippets</h2>
          <p className="text-xs text-[#747686]">
            Configure external IDEs and orchestrators to attach to this broker instance over stdio.
          </p>
        </div>

        <div className="space-y-4 text-xs">
          {/* MCP JSON Snippet */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="conn-mcp-json" className="font-semibold text-[#434655]">
                MCP JSON (Claude / Cursor / IDE)
              </label>
              <button
                type="button"
                className="h-7 px-2.5 bg-white border border-[#c4c5d7] text-xs font-medium text-[#141b2b] hover:bg-[#e9edff] flex items-center gap-1 cursor-pointer"
                onClick={() => copyToClipboard(snippets?.json ?? "", true)}
              >
                <CopyIcon size={12} />
                <span>{copiedJson.value ? "Copied!" : "Copy JSON"}</span>
              </button>
            </div>
            <textarea
              id="conn-mcp-json"
              readOnly
              className="w-full h-40 p-2 font-mono text-[11px] bg-[#f1f3f5] border border-[#c4c5d7] text-[#141b2b] select-all"
              value={snippets?.json ?? "{}"}
            />
          </div>

          {/* Codex TOML Snippet */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label htmlFor="conn-codex-toml" className="font-semibold text-[#434655]">
                Codex TOML (codex config)
              </label>
              <button
                type="button"
                className="h-7 px-2.5 bg-white border border-[#c4c5d7] text-xs font-medium text-[#141b2b] hover:bg-[#e9edff] flex items-center gap-1 cursor-pointer"
                onClick={() => copyToClipboard(snippets?.toml ?? "", false)}
              >
                <CopyIcon size={12} />
                <span>{copiedToml.value ? "Copied!" : "Copy TOML"}</span>
              </button>
            </div>
            <textarea
              id="conn-codex-toml"
              readOnly
              className="w-full h-36 p-2 font-mono text-[11px] bg-[#f1f3f5] border border-[#c4c5d7] text-[#141b2b] select-all"
              value={snippets?.toml ?? ""}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
