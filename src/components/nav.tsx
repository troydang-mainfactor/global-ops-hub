"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Today" },
  { href: "/inbound", label: "Inbound" },
  { href: "/products", label: "Products" },
  { href: "/launches", label: "Launches" },
  { href: "/settings", label: "Settings" },
];

export function Nav({ email, running = [] }: { email: string; running?: string[] }) {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-bg/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-2">
        <span className="font-semibold whitespace-nowrap">Ops Hub</span>
        <nav className="flex flex-1 gap-1 overflow-x-auto text-sm">
          {TABS.map((t) => {
            const active = t.href === "/" ? path === "/" : path.startsWith(t.href);
            return (
              <Link key={t.href} href={t.href} className={`whitespace-nowrap rounded px-2 py-1 ${active ? "bg-card font-medium shadow-sm" : "text-muted hover:text-ink"}`}>
                {t.label}
              </Link>
            );
          })}
        </nav>
        {running.length > 0 && (
          <Link href="/settings#jobs" className="flex items-center gap-1 whitespace-nowrap rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-800 dark:bg-sky-950 dark:text-sky-200" title={running.join(", ")}>
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-sky-500" /> Syncing…
          </Link>
        )}
        <span className="hidden text-xs text-muted sm:inline">{email}</span>
      </div>
    </header>
  );
}
