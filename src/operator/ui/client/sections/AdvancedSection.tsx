import { useEffect } from "preact/hooks";
import type { JSX } from "preact";
import {
  advancedDraft,
  advancedError,
  applyAdvancedDraft,
  cancelAdvancedDraft,
  draftConfig,
  initAdvancedDraft,
} from "../store.ts";
import { CheckIcon, XIcon } from "../components/Icons.tsx";

export function AdvancedSection(): JSX.Element {
  useEffect(() => {
    if (!advancedDraft.value) {
      initAdvancedDraft();
    }
  }, [draftConfig.value]);

  const draft = advancedDraft.value;
  if (!draft) {
    return <div className="p-4 text-xs text-[#747686]">Loading advanced settings…</div>;
  }

  const updateField = (field: keyof typeof draft, val: string) => {
    advancedDraft.value = {
      ...advancedDraft.value!,
      [field]: val,
    };
  };

  return (
    <div className="flex-1 p-4 bg-[#f8f9fa] overflow-y-auto space-y-4">
      <div className="border border-[#c4c5d7] bg-white p-4 space-y-4 max-w-3xl">
        <div className="border-b border-[#e5e7eb] pb-2 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-[#141b2b]">
              Advanced Raw Configuration
            </h2>
            <p className="text-xs text-[#747686]">
              Low-level configuration of accounts, binary pins, state directory, and workspace coverage rules.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="h-8 px-3 bg-white border border-[#c4c5d7] text-xs font-medium text-[#141b2b] hover:bg-[#e9edff] cursor-pointer"
              onClick={cancelAdvancedDraft}
            >
              Reset to draft
            </button>
            <button
              type="button"
              className="h-8 px-3 bg-[#1d4ed8] text-white text-xs font-medium hover:bg-[#1e40af] flex items-center gap-1.5 cursor-pointer"
              onClick={applyAdvancedDraft}
            >
              <CheckIcon size={14} />
              <span>Apply to draft</span>
            </button>
          </div>
        </div>

        {advancedError.value && (
          <div className="p-2.5 bg-[#fef2f2] border border-[#fecaca] text-[#dc2626] text-xs font-medium">
            {advancedError.value}
          </div>
        )}

        <div className="space-y-4 text-xs">
          {/* State Directory */}
          <div>
            <label htmlFor="adv-state-dir" className="block font-medium text-[#434655] mb-1">
              Broker State Directory (state_dir)
            </label>
            <input
              id="adv-state-dir"
              type="text"
              className="w-full h-8 px-2 border border-[#c4c5d7] font-mono text-xs focus:border-[#1d4ed8]"
              value={draft.stateDir}
              onInput={(e) => updateField("stateDir", (e.target as HTMLInputElement).value)}
            />
          </div>

          {/* Accounts JSON */}
          <div>
            <label htmlFor="adv-accounts-json" className="block font-medium text-[#434655] mb-1">
              Accounts JSON (accounts)
            </label>
            <textarea
              id="adv-accounts-json"
              className="w-full h-36 p-2 font-mono text-[11px] bg-[#f8f9fa] border border-[#c4c5d7] text-[#141b2b] focus:border-[#1d4ed8]"
              value={draft.accountsJson}
              onInput={(e) =>
                updateField("accountsJson", (e.target as HTMLTextAreaElement).value)
              }
            />
          </div>

          {/* Native Binary Pins JSON */}
          <div>
            <label htmlFor="adv-pins-json" className="block font-medium text-[#434655] mb-1">
              Native Binary Pins JSON (native_binary_pins)
            </label>
            <textarea
              id="adv-pins-json"
              className="w-full h-32 p-2 font-mono text-[11px] bg-[#f8f9fa] border border-[#c4c5d7] text-[#141b2b] focus:border-[#1d4ed8]"
              value={draft.pinsJson}
              onInput={(e) => updateField("pinsJson", (e.target as HTMLTextAreaElement).value)}
            />
          </div>

          {/* Coverage Profiles JSON */}
          <div>
            <label htmlFor="adv-coverage-json" className="block font-medium text-[#434655] mb-1">
              Coverage Profiles JSON (coverage_profiles)
            </label>
            <textarea
              id="adv-coverage-json"
              className="w-full h-36 p-2 font-mono text-[11px] bg-[#f8f9fa] border border-[#c4c5d7] text-[#141b2b] focus:border-[#1d4ed8]"
              value={draft.coverageJson}
              onInput={(e) =>
                updateField("coverageJson", (e.target as HTMLTextAreaElement).value)
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}
