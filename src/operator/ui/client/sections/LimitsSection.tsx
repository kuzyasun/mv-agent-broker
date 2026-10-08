import type { JSX } from "preact";
import { draftConfig } from "../store.ts";

export function LimitsSection(): JSX.Element {
  const limits = draftConfig.value?.limits ?? {};

  const updateLimit = (field: keyof typeof limits, value: number) => {
    draftConfig.value = {
      ...draftConfig.value!,
      limits: {
        ...(draftConfig.value?.limits ?? {}),
        [field]: value,
      },
    };
  };

  const deadlineMs = limits.hardTurnDeadlineMs ?? 3600000;
  const deadlineMinutes = Math.floor(deadlineMs / 60000);

  return (
    <div className="flex-1 p-4 bg-[#f8f9fa] overflow-y-auto space-y-4">
      <div className="border border-[#c4c5d7] bg-white p-4 space-y-4 max-w-2xl">
        <div className="border-b border-[#e5e7eb] pb-2">
          <h2 className="text-base font-semibold text-[#141b2b]">Execution & Concurrency Limits</h2>
          <p className="text-xs text-[#747686]">
            Control orchestrator admission, unfinished turn saturation, deadlines, and Git review diff budgets.
          </p>
        </div>

        <div className="space-y-4 text-xs">
          {/* Global Unfinished Turns */}
          <div>
            <label htmlFor="limit-global-unfinished" className="block font-medium text-[#434655] mb-1">
              Global Max Unfinished Turns
            </label>
            <input
              id="limit-global-unfinished"
              type="number"
              min="1"
              max="64"
              className="w-full max-w-xs h-8 px-2 border border-[#c4c5d7] font-mono text-xs focus:border-[#1d4ed8]"
              value={limits.globalUnfinishedTurns ?? 3}
              onInput={(e) => {
                const val = parseInt((e.target as HTMLInputElement).value, 10);
                if (!isNaN(val) && val > 0) updateLimit("globalUnfinishedTurns", val);
              }}
            />
            <p className="text-[11px] text-[#434655] mt-1">
              Maximum unfinished broker turns running concurrently across all projects.
            </p>
          </div>

          {/* Quota Scope Unfinished Turns */}
          <div>
            <label htmlFor="limit-quota-unfinished" className="block font-medium text-[#434655] mb-1">
              Quota Scope Max Unfinished Turns
            </label>
            <input
              id="limit-quota-unfinished"
              type="number"
              min="1"
              max="16"
              className="w-full max-w-xs h-8 px-2 border border-[#c4c5d7] font-mono text-xs focus:border-[#1d4ed8]"
              value={limits.quotaScopeUnfinishedTurns ?? 1}
              onInput={(e) => {
                const val = parseInt((e.target as HTMLInputElement).value, 10);
                if (!isNaN(val) && val > 0) updateLimit("quotaScopeUnfinishedTurns", val);
              }}
            />
            <p className="text-[11px] text-[#434655] mt-1">
              Concurrency throttle per quota scope (provider / account group) to prevent rate limit saturation.
            </p>
          </div>

          {/* Hard Turn Deadline */}
          <div>
            <label htmlFor="limit-turn-deadline" className="block font-medium text-[#434655] mb-1">
              Hard Turn Deadline (Minutes)
            </label>
            <div className="flex items-center gap-2">
              <input
                id="limit-turn-deadline"
                type="number"
                min="1"
                max="1440"
                className="w-full max-w-xs h-8 px-2 border border-[#c4c5d7] font-mono text-xs focus:border-[#1d4ed8]"
                value={deadlineMinutes}
                onInput={(e) => {
                  const mins = parseInt((e.target as HTMLInputElement).value, 10);
                  if (!isNaN(mins) && mins > 0) {
                    updateLimit("hardTurnDeadlineMs", mins * 60000);
                  }
                }}
              />
              <span className="text-[#434655] text-xs font-mono">
                ({deadlineMs} ms)
              </span>
            </div>
            <p className="text-[11px] text-[#434655] mt-1">
              Individual agent turn hard execution deadline before cancellation and timeout enforcement.
            </p>
          </div>

          {/* Max Review Diff Bytes */}
          <div>
            <label htmlFor="limit-review-diff" className="block font-medium text-[#434655] mb-1">
              Max Review Diff Budget (Bytes)
            </label>
            <div className="flex items-center gap-2">
              <input
                id="limit-review-diff"
                type="number"
                min="1048576"
                step="1048576"
                className="w-full max-w-xs h-8 px-2 border border-[#c4c5d7] font-mono text-xs focus:border-[#1d4ed8]"
                value={limits.maxReviewDiffBytes ?? 33554432}
                onInput={(e) => {
                  const bytes = parseInt((e.target as HTMLInputElement).value, 10);
                  if (!isNaN(bytes) && bytes > 0) {
                    updateLimit("maxReviewDiffBytes", bytes);
                  }
                }}
              />
              <span className="text-[#434655] text-xs font-mono">
                (~{Math.round((limits.maxReviewDiffBytes ?? 33554432) / (1024 * 1024))} MiB)
              </span>
            </div>
            <p className="text-[11px] text-[#747686] mt-1">
              Maximum allowed snapshot diff size for reviewer turns.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
