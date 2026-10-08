import { useEffect } from "preact/hooks";
import type { JSX } from "preact";
import {
  clearQuotaPauseAction,
  closeTurnErrorAction,
  displayPreferences,
  loadTurnErrorAction,
  refreshStatus,
  selectedTurnError,
  statusData,
  statusLoading,
  turnErrorLoading,
} from "../store.ts";
import { formatTimestamp } from "../profile.ts";
import { RefreshIcon, XIcon } from "../components/Icons.tsx";

export function OverviewSection(): JSX.Element {
  const status = statusData.value;
  const prefs = displayPreferences.value;
  const errorDetail = selectedTurnError.value;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && selectedTurnError.value) {
        closeTurnErrorAction();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const activeTurns = status?.active_turns ?? [];
  const errorTurns = status?.error_turns ?? [];
  const quotaPauses = status?.quota_pauses ?? [];

  return (
    <div className="flex-1 flex overflow-hidden">
      <div className="flex-1 p-4 bg-[#f8f9fa] overflow-y-auto space-y-4">
        {/* Runtime Overview Card */}
        <div className="border border-[#c4c5d7] bg-white p-4 space-y-3">
          <div className="flex items-center justify-between border-b border-[#e5e7eb] pb-2">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold text-[#141b2b]">Live Broker Runtime</h2>
              <span
                className={`px-2 py-0.5 text-xs font-mono font-semibold uppercase ${
                  status?.status === "ready"
                    ? "bg-[#ecfdf5] border border-[#a7f3d0] text-[#059669]"
                    : status?.status === "stopped"
                      ? "bg-[#fffbeb] border border-[#fde68a] text-[#d97706]"
                      : "bg-[#fef2f2] border border-[#fecaca] text-[#dc2626]"
                }`}
              >
                {statusLoading.value && !status
                  ? "LOADING…"
                  : status?.readiness || status?.status?.toUpperCase() || "UNKNOWN"}
              </span>
            </div>

            <button
              type="button"
              className="h-8 px-3 bg-white border border-[#c4c5d7] text-xs font-medium text-[#141b2b] hover:bg-[#e9edff] flex items-center gap-1.5 cursor-pointer"
              onClick={() => void refreshStatus()}
              disabled={statusLoading.value}
            >
              <RefreshIcon size={14} />
              <span>{statusLoading.value ? "Refreshing…" : "Refresh status"}</span>
            </button>
          </div>

          {statusLoading.value && !status ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs animate-pulse">
              <div className="h-12 bg-[#e9edff] border border-[#c4c5d7]" />
              <div className="h-12 bg-[#e9edff] border border-[#c4c5d7]" />
              <div className="h-12 bg-[#e9edff] border border-[#c4c5d7]" />
              <div className="h-12 bg-[#e9edff] border border-[#c4c5d7]" />
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <div className="p-2 bg-[#f8f9fa] border border-[#e5e7eb]">
                <span className="text-[#434655] block text-[11px]">Daemon PID</span>
                <span className="font-mono font-semibold text-[#141b2b]">
                  {status?.daemon_pid ?? "None (stopped)"}
                </span>
              </div>

              <div className="p-2 bg-[#f8f9fa] border border-[#e5e7eb]">
                <span className="text-[#434655] block text-[11px]">Runtime Version</span>
                <span className="font-mono text-[#141b2b]">
                  {status?.runtime_version ?? "Unknown"}
                </span>
              </div>

              <div className="p-2 bg-[#f8f9fa] border border-[#e5e7eb]">
                <span className="text-[#434655] block text-[11px]">Committed Commit</span>
                <span className="font-mono text-[#141b2b] truncate block" title={status?.runtime_commit ?? ""}>
                  {status?.runtime_commit ? status.runtime_commit.slice(0, 10) : "Unknown"}
                </span>
              </div>

              <div className="p-2 bg-[#f8f9fa] border border-[#e5e7eb]">
                <span className="text-[#434655] block text-[11px]">Observation</span>
                <span className="font-mono text-[#141b2b]">
                  {status?.runtime_observation ?? "Unknown"}
                </span>
              </div>
            </div>
          )}

          <div className="text-xs text-[#434655] space-y-1">
            <div>
              <span className="font-medium text-[#141b2b]">State Directory: </span>
              <span className="font-mono">{status?.state_dir ?? "Unknown"}</span>
            </div>
            {status?.applied_config_fingerprint && (
              <div>
                <span className="font-medium text-[#141b2b]">Applied Config Fingerprint: </span>
                <span className="font-mono">{status.applied_config_fingerprint}</span>
              </div>
            )}
          </div>
        </div>

        {/* Quota Pauses */}
        <div className="border border-[#c4c5d7] bg-white">
          <div className="h-9 px-3 bg-[#f1f3ff] border-b border-[#c4c5d7] flex items-center justify-between text-xs font-semibold text-[#141b2b]">
            <span>Active Quota Pauses ({quotaPauses.length})</span>
          </div>

          {quotaPauses.length === 0 ? (
            <div className="p-4 text-xs text-[#434655] font-mono">
              No active quota pauses observed.
            </div>
          ) : (
            <div className="divide-y divide-[#e5e7eb]">
              {quotaPauses.map((pause, idx) => (
                <div key={idx} className="p-3 flex items-center justify-between gap-3 text-xs">
                  <div>
                    <div className="font-semibold text-[#d97706]">
                      {pause.provider} ({pause.quota_scope_id})
                    </div>
                    <div className="text-[11px] text-[#434655]">
                      Retry after: {formatTimestamp(pause.retry_after, prefs)}
                      {pause.detail && ` — ${pause.detail}`}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="h-7 px-2.5 bg-white border border-[#c4c5d7] text-xs font-medium text-[#141b2b] hover:bg-[#e9edff] cursor-pointer"
                    onClick={() => void clearQuotaPauseAction(pause.provider, pause.quota_scope_id)}
                  >
                    Clear pause
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Active Jobs Grid / List */}
        <div className="border border-[#c4c5d7] bg-white">
          <div className="h-9 px-3 bg-[#f1f3ff] border-b border-[#c4c5d7] flex items-center justify-between text-xs font-semibold text-[#141b2b]">
            <span>Active Turns ({activeTurns.length})</span>
          </div>

          {activeTurns.length === 0 ? (
            <div className="p-4 text-xs text-[#434655] font-mono">
              No active turns running currently.
            </div>
          ) : (
            <div className="divide-y divide-[#e5e7eb]">
              {activeTurns.map((turn) => (
                <div key={turn.turn_id} className="p-3 flex items-center justify-between gap-3 text-xs">
                  <div className="space-y-0.5">
                    <div className="font-mono font-semibold text-[#141b2b]">{turn.turn_id}</div>
                    <div className="text-[11px] text-[#434655]">
                      Started: {formatTimestamp(turn.started_at, prefs)}
                      {turn.model && ` | Model: ${turn.model}`}
                      {turn.role && ` | Role: ${turn.role}`}
                    </div>
                  </div>
                  <span className="px-2 py-0.5 text-[11px] font-mono uppercase bg-[#ecfdf5] border border-[#a7f3d0] text-[#059669]">
                    Active
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Turn Errors */}
        <div className="border border-[#c4c5d7] bg-white">
          <div className="h-9 px-3 bg-[#f1f3ff] border-b border-[#c4c5d7] flex items-center justify-between text-xs font-semibold text-[#141b2b]">
            <span>Recent Turn Errors ({errorTurns.length})</span>
          </div>

          {errorTurns.length === 0 ? (
            <div className="p-4 text-xs text-[#434655] font-mono">
              No recent turn errors recorded.
            </div>
          ) : (
            <div className="divide-y divide-[#e5e7eb]">
              {errorTurns.map((turn) => (
                <div
                  key={turn.turn_id}
                  className="p-3 flex items-start justify-between gap-3 text-xs hover:bg-[#f8f9fa] cursor-pointer"
                  onClick={() => void loadTurnErrorAction(turn.turn_id)}
                >
                  <div className="space-y-0.5">
                    <div className="font-mono font-semibold text-[#dc2626]">{turn.turn_id}</div>
                    <div className="text-[11px] text-[#434655]">
                      Failed: {formatTimestamp(turn.failed_at, prefs)}
                      {turn.error_code && ` | Code: ${turn.error_code}`}
                    </div>
                    {turn.error_message && (
                      <div className="text-xs text-[#141b2b]">{turn.error_message}</div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="h-7 px-2.5 bg-white border border-[#c4c5d7] text-xs font-medium text-[#141b2b] hover:bg-[#e9edff] cursor-pointer"
                  >
                    Inspect
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Turn Error Inspector Drawer */}
      {errorDetail && (
        <aside className="w-[450px] bg-white border-l border-[#c4c5d7] flex flex-col shrink-0 z-20 shadow-none">
          <div className="h-10 px-3 bg-[#f1f3ff] border-b border-[#c4c5d7] flex items-center justify-between">
            <span className="text-xs font-semibold text-[#dc2626]">
              Turn Error: {errorDetail.turn_id}
            </span>
            <button
              type="button"
              className="p-1 text-[#434655] hover:text-[#141b2b] cursor-pointer"
              onClick={closeTurnErrorAction}
            >
              <XIcon size={16} />
            </button>
          </div>

          <div className="flex-1 p-3 overflow-y-auto">
            {turnErrorLoading.value ? (
              <div className="text-xs text-[#434655]">Loading turn error diagnostics…</div>
            ) : (
              <pre className="font-mono text-[11px] bg-[#f1f3f5] p-3 border border-[#e5e7eb] overflow-x-auto whitespace-pre-wrap text-[#141b2b]">
                {JSON.stringify(errorDetail, null, 2)}
              </pre>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
