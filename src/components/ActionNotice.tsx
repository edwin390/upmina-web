import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { getActionNotice, subscribeActionNotice } from "@/lib/action-notice";

/** Reuses the Cosplay success notice design; survives dialog and route unmounts. */
export default function ActionNotice() {
  const notice = useSyncExternalStore(subscribeActionNotice, getActionNotice);
  return notice
    ? createPortal(
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex justify-center px-4"
        >
          <p className="max-w-lg break-words rounded-md border border-accent-primary/60 bg-bg-surface px-4 py-2.5 text-sm font-semibold text-text-primary shadow-glow-primary">
            {notice.message}
          </p>
        </div>,
        document.body,
      )
    : null;
}
