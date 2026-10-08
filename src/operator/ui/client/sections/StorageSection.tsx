import { useSignal } from "@preact/signals";
import type { JSX } from "preact";
import { executeStorage, previewStorage } from "../api.ts";
import { draftConfig, setActionMessage } from "../store.ts";
import type { StoragePreview } from "../types.ts";

export function StorageSection(): JSX.Element {
  const projects = draftConfig.value?.projects ?? [];
  const selectedProject = useSignal<string>(projects[0]?.project_id ?? "");
  const retentionDays = useSignal<string>("30");

  const preview = useSignal<StoragePreview | null>(null);
  const isPreviewing = useSignal<boolean>(false);
  const isExecuting = useSignal<boolean>(false);
  const lastResult = useSignal<{ count: number; bytes: number } | null>(null);

  const invalidatePreview = () => {
    preview.value = null;
    lastResult.value = null;
  };

  const handlePreview = async () => {
    if (!selectedProject.value) {
      setActionMessage("Please select a project.", "warning", 3000);
      return;
    }
    const days = retentionDays.value.trim() === "" ? undefined : parseInt(retentionDays.value, 10);
    if (days !== undefined && (isNaN(days) || days < 0)) {
      setActionMessage("Retention days must be a non-negative integer.", "error", 4000);
      return;
    }

    const reqProject = selectedProject.value;
    isPreviewing.value = true;
    lastResult.value = null;
    try {
      const res = await previewStorage(reqProject, days);
      if (selectedProject.value === reqProject) {
        preview.value = res;
        setActionMessage("Storage cleanup preview generated.", "info", 3000);
      }
    } catch (err) {
      if (selectedProject.value === reqProject) {
        const msg = err instanceof Error ? err.message : String(err);
        setActionMessage(`Preview failed: ${msg}`, "error", 5000);
      }
    } finally {
      if (selectedProject.value === reqProject) {
        isPreviewing.value = false;
      }
    }
  };

  const handleExecute = async () => {
    if (!preview.value) return;
    const proceed = window.confirm(
      `Permanently delete ${preview.value.eligible_artifact_count} eligible artifacts for project '${preview.value.project_id}'?`,
    );
    if (!proceed) return;

    isExecuting.value = true;
    try {
      const res = await executeStorage(
        preview.value.project_id,
        preview.value.preview_token,
        preview.value.retention_days,
      );
      lastResult.value = {
        count: res.deleted_blob_count,
        bytes: res.deleted_blob_bytes,
      };
      preview.value = null; // Invalidate executed preview!
      setActionMessage(
        `Cleanup executed: deleted ${res.deleted_blob_count} blobs (${formatBytes(res.deleted_blob_bytes)}).`,
        "success",
        5000,
      );
    } catch (err) {
      preview.value = null; // Stale or invalid preview token must be cleared
      const msg = err instanceof Error ? err.message : String(err);
      setActionMessage(`Cleanup execution failed: ${msg}`, "error", 5000);
    } finally {
      isExecuting.value = false;
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / 1048576).toFixed(1)} MiB`;
  };

  return (
    <div className="flex-1 p-4 bg-[#f8f9fa] overflow-y-auto space-y-4">
      <div className="border border-[#c4c5d7] bg-white p-4 space-y-4 max-w-2xl">
        <div className="border-b border-[#e5e7eb] pb-2">
          <h2 className="text-base font-semibold text-[#141b2b]">Storage Maintenance & Pruning</h2>
          <p className="text-xs text-[#747686]">
            Preview and clean up historical artifacts and registered snapshot blobs by project and age.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <div>
            <label htmlFor="storage-project-select" className="block font-medium text-[#434655] mb-1">
              Project
            </label>
            <select
              id="storage-project-select"
              className="w-full h-8 px-2 border border-[#c4c5d7] text-xs bg-white focus:border-[#1d4ed8] cursor-pointer"
              value={selectedProject.value}
              onChange={(e) => {
                selectedProject.value = (e.target as HTMLSelectElement).value;
                invalidatePreview();
              }}
            >
              {projects.map((p) => (
                <option key={p.project_id} value={p.project_id}>
                  {p.display_name || p.project_id}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="storage-retention-days" className="block font-medium text-[#434655] mb-1">
              Retention Days (keep newer than)
            </label>
            <input
              id="storage-retention-days"
              type="number"
              min="0"
              max="3650"
              className="w-full h-8 px-2 border border-[#c4c5d7] font-mono text-xs focus:border-[#1d4ed8]"
              placeholder="30"
              value={retentionDays.value}
              onInput={(e) => {
                retentionDays.value = (e.target as HTMLInputElement).value;
                invalidatePreview();
              }}
            />
          </div>
        </div>

        <div className="pt-2">
          <button
            type="button"
            className="h-8 px-4 bg-white border border-[#c4c5d7] text-[#141b2b] text-xs font-medium hover:bg-[#e9edff] cursor-pointer"
            disabled={isPreviewing.value || !selectedProject.value}
            onClick={handlePreview}
          >
            {isPreviewing.value ? "Generating Preview…" : "Preview Cleanup"}
          </button>
        </div>

        {/* Preview Summary */}
        {preview.value && (
          <div className="p-3 bg-[#f1f3ff] border border-[#c4c5d7] space-y-3 text-xs">
            <div className="font-semibold text-[#141b2b] border-b border-[#c4c5d7] pb-1">
              Cleanup Preview Summary: {preview.value.project_id}
            </div>

            <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
              <div>
                <span className="text-[#434655]">Eligible artifacts: </span>
                <span className="font-semibold text-[#dc2626]">
                  {preview.value.eligible_artifact_count}
                </span>
              </div>
              <div>
                <span className="text-[#434655]">Protected artifacts: </span>
                <span className="font-semibold text-[#059669]">
                  {preview.value.protected_artifact_count}
                </span>
              </div>
              <div>
                <span className="text-[#434655]">Registered blobs: </span>
                <span>{preview.value.registered_blob_count}</span>
              </div>
              <div>
                <span className="text-[#434655]">Blob bytes: </span>
                <span>{formatBytes(preview.value.registered_blob_bytes)}</span>
              </div>
              <div>
                <span className="text-[#434655]">Retained recent: </span>
                <span>{preview.value.retained_recent_count}</span>
              </div>
            </div>

            <div className="pt-2">
              <button
                type="button"
                className="h-8 px-4 bg-[#fef2f2] text-[#dc2626] border border-[#dc2626] text-xs font-medium hover:bg-[#dc2626] hover:text-white cursor-pointer"
                disabled={isExecuting.value}
                onClick={handleExecute}
              >
                {isExecuting.value ? "Executing Deletion…" : "Execute Cleanup"}
              </button>
            </div>
          </div>
        )}

        {/* Execution Result */}
        {lastResult.value && (
          <div className="p-3 bg-[#ecfdf5] border border-[#a7f3d0] text-xs text-[#059669]">
            Successfully deleted {lastResult.value.count} blobs (
            {formatBytes(lastResult.value.bytes)}).
          </div>
        )}
      </div>
    </div>
  );
}
