"use client";
import { useFormStatus } from "react-dom";

export function RunButton({ running, disabledReason }: { running: boolean; disabledReason: string | null }) {
  const { pending } = useFormStatus();
  const busy = pending || running;
  return (
    <button
      disabled={busy || Boolean(disabledReason)}
      title={disabledReason ?? (running ? "Running in the background. You can leave this page." : "Run now")}
      className="rounded-md bg-ink px-2.5 py-1 text-sm text-bg disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending ? "Starting…" : running ? "Running…" : "Run now"}
    </button>
  );
}
