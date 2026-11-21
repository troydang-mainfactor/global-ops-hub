import type { ReactNode } from "react";

export function Card({ title, children, right, id }: { title?: ReactNode; children: ReactNode; right?: ReactNode; id?: string }) {
  return (
    <section id={id} className="rounded-lg border border-line bg-card p-4">
      {(title || right) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="font-semibold">{title}</h2>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

const SEV: Record<string, string> = {
  red: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
  yellow: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  info: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  gray: "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
};

export function Pill({ tone = "gray", children }: { tone?: keyof typeof SEV | string; children: ReactNode }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${SEV[tone] ?? SEV.gray}`}>{children}</span>;
}

export function Button({ children, tone = "default", ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "default" | "primary" | "danger" }) {
  const cls =
    tone === "primary" ? "bg-ink text-bg" : tone === "danger" ? "border border-red-300 text-red-700 dark:text-red-300" : "border border-line";
  return (
    <button {...rest} className={`rounded-md px-2.5 py-1 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${cls} ${rest.className ?? ""}`}>
      {children}
    </button>
  );
}

export function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function fmtDateTime(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function daysSince(d: Date | null | undefined, now = new Date()): number | null {
  return d ? Math.floor((now.getTime() - d.getTime()) / 86400000) : null;
}
