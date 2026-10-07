import type { JSX } from "preact";
import { actionMessage, clearActionMessage } from "../store.ts";
import { AlertCircleIcon, CheckIcon, XIcon } from "./Icons.tsx";

export function ActionToast(): JSX.Element | null {
  const msg = actionMessage.value;
  if (!msg) return null;

  let bgClass = "bg-[#f1f3f5] border-[#c4c5d7] text-[#141b2b]";
  let IconComponent = AlertCircleIcon;

  if (msg.kind === "success") {
    bgClass = "bg-[#ecfdf5] border-[#a7f3d0] text-[#059669]";
    IconComponent = CheckIcon;
  } else if (msg.kind === "warning") {
    bgClass = "bg-[#fffbeb] border-[#fde68a] text-[#d97706]";
    IconComponent = AlertCircleIcon;
  } else if (msg.kind === "error") {
    bgClass = "bg-[#fef2f2] border-[#fecaca] text-[#dc2626]";
    IconComponent = AlertCircleIcon;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className={`border px-3 py-2 flex items-center justify-between gap-3 text-xs font-medium z-40 shrink-0 ${bgClass}`}
    >
      <div className="flex items-center gap-2 overflow-hidden">
        <IconComponent size={16} className="shrink-0" />
        <span className="truncate">{msg.text}</span>
      </div>
      <button
        type="button"
        onClick={clearActionMessage}
        className="text-current opacity-70 hover:opacity-100 p-0.5 cursor-pointer shrink-0"
        title="Dismiss"
      >
        <XIcon size={14} />
      </button>
    </div>
  );
}
