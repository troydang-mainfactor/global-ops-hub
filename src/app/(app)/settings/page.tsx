import { db } from "@/lib/db";
import { getSettings, DEFAULT_SETTINGS } from "@/lib/settings";
import { JOBS } from "@/lib/jobs/registry";
import { gmailConfigured, gmailLabelsEnabled } from "@/lib/gmail/client";
import { aiConfigured, aiModel } from "@/lib/ai/client";
import { Button, Card, Pill, fmtDateTime } from "@/components/ui";
import { AutoRefresh } from "@/components/auto-refresh";
import { RunButton } from "@/components/run-button";
import { accountForStore, tokenSet } from "@/lib/shiphero/accounts";
import { tokenInfo } from "@/lib/shiphero/client";
import type { Prisma, ShipheroAccount } from "@prisma/client";
import {
  assignPrefix, deleteShipheroAccount, deleteStore, deleteWarehouse, enableManagerStores, importStores, runJobNow,
  saveShipheroAccount, saveStore, saveThresholds, saveWarehouse, toggleStore,
} from "./actions";

const THRESHOLD_LABELS: Record<keyof typeof DEFAULT_SETTINGS, string> = {
  receivingBufferDays: "Receiving buffer (days, delivery → sellable)",
  shippedNotReceivedDays: "R04: shipped and not received after (days)",
  issuedNoShipheroHours: "R01: issued with no ShipHero PO after (hours)",
  launchWindowDays: "Launch window (days)",
  preorderTags: "Pre-order product tags (comma separated)",
  gmailQuery: "Gmail search for PO emails (only these are read)",
  backfillDays: "Gmail backfill window (days)",
  incrementalDays: "Gmail poll looks back (days)",
  aiLowConfidence: "AI parse confidence below this raises R17 (0–1)",
  pdfMaxPerRun: "Max PO PDFs parsed per run",
};

// Server actions on this page (e.g. Run now) inherit this limit; background jobs run up to 5 minutes.
export const maxDuration = 300;

export default async function SettingsPage() {
  const [stores, users, warehouses, accounts, settings, runs, unmatchedRaw] = await Promise.all([
    db.store.findMany({ include: { manager: true }, orderBy: [{ enabled: "desc" }, { name: "asc" }] }),
    db.user.findMany({ orderBy: { name: "asc" } }),
    db.warehouse.findMany({ orderBy: { emailCode: "asc" } }),
    db.shipheroAccount.findMany({ orderBy: { name: "asc" } }),
    getSettings(db),
    db.syncRun.findMany({ orderBy: { startedAt: "desc" }, take: 20 }),
    db.emailMessage.findMany({ where: { status: "skipped", skipReason: "unknown_store" }, select: { baseSku: true } }),
  ]);
  // Global SKUs look like FALRNR103455RD: the leading letters are the store prefix.
  const byPrefix = new Map<string, { prefix: string; example: string; count: number }>();
  for (const { baseSku } of unmatchedRaw) {
    if (!baseSku) continue;
    const prefix = baseSku.match(/^[A-Z]{2,4}/)?.[0] ?? baseSku.slice(0, 4);
    const e = byPrefix.get(prefix) ?? { prefix, example: baseSku, count: 0 };
    e.count++;
    byPrefix.set(prefix, e);
  }
  const unmatched = [...byPrefix.values()].sort((a, b) => b.count - a.count);
  const openStores = stores.filter((s) => !s.closed);
  // ShipHero profile names seen by the last sync, for the per-store profile picker.
  const profileStates = await db.syncState.findMany({ where: { key: { startsWith: "sh:wh:" } } });
  const shipheroProfiles = [...new Set(profileStates.flatMap((r) => ((r.value as { profiles?: string[] })?.profiles ?? [])))].sort();
  const storeCount = (accountId: string) => openStores.filter((s) => accountForStore(s, accounts)?.id === accountId).length;
  const closedStores = stores.filter((s) => s.closed);
  const managers = users.filter((u) => stores.some((s) => s.managerId === u.id));

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Settings</h1>
      <nav className="flex flex-wrap gap-2 text-sm text-muted">
        {["connections", "stores", "warehouses", "shiphero", "thresholds", "jobs"].map((a) => (
          <a key={a} href={`#${a}`} className="underline-offset-2 hover:underline">{a}</a>
        ))}
      </nav>

      <Card id="connections" title="Connections">
        <ul className="space-y-1 text-sm">
          <Conn ok={gmailConfigured()} label="Gmail" detail={`${process.env.GMAIL_MAILBOX || "GMAIL_MAILBOX not set"} · search: ${settings.gmailQuery} · ${gmailLabelsEnabled() ? "read + label" : "read-only"}`} />
          <Conn ok={aiConfigured()} label="Claude API" detail={aiConfigured() ? `${aiModel()} (PDF parsing + email fallback)` : "ANTHROPIC_API_KEY not set: regex only, PDFs wait"} />
          <Conn ok={Boolean(process.env.CRON_SECRET)} label="Cron secret" detail="Protects /api/jobs/* for the scheduler" />
        </ul>
      </Card>

      <Card id="stores" title={`Stores (${stores.filter((s) => s.enabled).length} of ${stores.length} enabled)`}>
        <p className="mb-3 text-sm text-muted">
          PO emails are matched to a store by <b>Global SKU prefix</b> (e.g. FALR for Falling In Reverse), which can differ from our store code.
          Each store&apos;s warehouse (Mainfactor Michigan / Philly) decides where its POs are matched in ShipHero. Only enabled stores are processed; turning one on applies its already-seen emails on the next run.
        </p>
        {managers.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            {managers.map((m) => (
              <form key={m.id} action={enableManagerStores} className="flex items-center gap-1 rounded border border-line px-2 py-1">
                <input type="hidden" name="managerId" value={m.id} />
                <span>{m.name}</span>
                <Button name="enabled" value="1">Enable all</Button>
                <Button name="enabled" value="0">Disable all</Button>
              </form>
            ))}
          </div>
        )}
        <div className="divide-y divide-line">
          {openStores.map((s) => <StoreRowView key={s.id} s={s} accounts={accounts} />)}
        </div>
        {closedStores.length > 0 && (
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-muted">Closed stores ({closedStores.length})</summary>
            <div className="divide-y divide-line">{closedStores.map((s) => <StoreRowView key={s.id} s={s} accounts={accounts} />)}</div>
          </details>
        )}
        <datalist id="shiphero-profiles">{shipheroProfiles.map((n) => <option key={n} value={n} />)}</datalist>
        <datalist id="warehouse-names">{[...new Set([...warehouses.map((w) => w.name), ...stores.map((s) => s.warehouseName)].filter(Boolean))].map((n) => <option key={n!} value={n!} />)}</datalist>
        <datalist id="managers">{users.map((u) => <option key={u.id} value={u.email ?? u.name} />)}</datalist>
        <form action={saveStore} className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <input name="name" placeholder="Store name" className="w-44" required />
          <input name="code" placeholder="Our code" className="w-24 font-mono" />
          <input name="skuPrefixes" placeholder="Global SKU prefix" className="w-36 font-mono" />
          <input name="manager" placeholder="MF manager" className="w-36" list="managers" />
          <label className="flex items-center gap-1 text-sm"><input type="checkbox" name="enabled" /> Enabled</label>
          <Button tone="primary">Add store</Button>
        </form>
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-muted">Import store list (paste from the sheet, with headers)</summary>
          <form action={importStores} className="mt-2 space-y-2">
            <textarea name="csv" rows={6} className="w-full font-mono text-xs" placeholder={"Store\tStore Code\tMF Store Manager\tGlobal Store Manager\tTier\tWarehouse\tGlobal SKU Prefix"} />
            <p className="text-xs text-muted">Matched by store code, else name. New stores start disabled; &quot;(CLOSED)&quot; stores are marked closed. Add a &quot;Global SKU Prefix&quot; column to set prefixes in bulk.</p>
            <Button tone="primary">Import</Button>
          </form>
        </details>
        {unmatched.length > 0 && (
          <div className="mt-3 border-t border-line pt-3 text-sm">
            <p className="mb-2 text-muted">SKU prefixes in PO emails that don&apos;t match any store. Assign each to its store:</p>
            <div className="space-y-1">
              {unmatched.map((u) => (
                <form key={u.prefix} action={assignPrefix} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="prefix" value={u.prefix} />
                  <span className="w-14 font-mono font-medium">{u.prefix}</span>
                  <span className="font-mono text-xs text-muted">{u.example} · {u.count} email{u.count > 1 ? "s" : ""}</span>
                  <select name="storeId" defaultValue="" className="w-56">
                    <option value="" disabled>Store…</option>
                    {openStores.map((s) => <option key={s.id} value={s.id}>{s.name}{s.code ? ` (${s.code})` : ""}</option>)}
                  </select>
                  <Button>Assign</Button>
                </form>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card id="warehouses" title="Warehouse codes">
        <p className="mb-3 text-sm text-muted">Warehouse codes in the PO emails and the warehouse each one means (e.g. MAINF PA = Mainfactor Philly). Used to check a PO goes to the store&apos;s own warehouse. Untick &quot;In ShipHero&quot; for one that isn&apos;t tracked in ShipHero.</p>
        <div className="divide-y divide-line">
          {warehouses.map((w) => (
            <div key={w.id} className="flex flex-wrap items-center gap-2 py-2">
              <form action={saveWarehouse} className="flex flex-1 flex-wrap items-center gap-2">
                <input type="hidden" name="id" value={w.id} />
                <input name="emailCode" defaultValue={w.emailCode} className="w-28 font-mono" aria-label="Email code" />
                <input name="name" defaultValue={w.name ?? ""} placeholder="Name" className="w-44" />
                <label className="flex items-center gap-1 text-sm"><input type="checkbox" name="inShiphero" defaultChecked={w.inShiphero} /> In ShipHero</label>
                <Button>Save</Button>
              </form>
              <form action={deleteWarehouse}>
                <input type="hidden" name="id" value={w.id} />
                <Button tone="danger">Delete</Button>
              </form>
            </div>
          ))}
        </div>
        <form action={saveWarehouse} className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <input name="emailCode" placeholder="EMAIL CODE" className="w-28 font-mono" required />
          <input type="hidden" name="inShiphero" value="on" />
          <Button tone="primary">Add warehouse</Button>
        </form>
      </Card>

      <Card id="shiphero" title="ShipHero accounts">
        <p className="mb-3 text-sm text-muted">One ShipHero login per warehouse. Stores use the account for their warehouse. Store only the <b>name</b> of the env var holding the refresh token (e.g. SHIPHERO_TOKEN_MICHIGAN), never the token.</p>
        <div className="divide-y divide-line">
          {accounts.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-2 py-2">
              <form action={saveShipheroAccount} className="flex flex-1 flex-wrap items-center gap-2">
                <input type="hidden" name="id" value={a.id} />
                <input name="name" defaultValue={a.name} className="w-40" />
                <input name="warehouseName" defaultValue={a.warehouseName ?? ""} placeholder="Warehouse" list="warehouse-names" className="w-44" />
                <span className="text-xs text-muted">{storeCount(a.id)} stores</span>
                <select name="type" defaultValue={a.type}><option value="direct">direct</option><option value="3pl">3pl</option></select>
                <input name="tokenRef" defaultValue={a.tokenRef} className="w-52 font-mono" />
                <input name="customerAccountId" defaultValue={a.customerAccountId ?? ""} placeholder="customer_account_id" className="w-40 font-mono" />
                <TokenPill tokenRef={a.tokenRef} />
                <Button>Save</Button>
              </form>
              <form action={deleteShipheroAccount}>
                <input type="hidden" name="id" value={a.id} />
                <Button tone="danger">Delete</Button>
              </form>
            </div>
          ))}
        </div>
        <form action={saveShipheroAccount} className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <input name="name" placeholder="Account name" className="w-40" required />
          <input name="warehouseName" placeholder="Warehouse" list="warehouse-names" className="w-44" />
          <select name="type"><option value="direct">direct</option><option value="3pl">3pl</option></select>
          <input name="tokenRef" placeholder="SHIPHERO_TOKEN_…" className="w-52 font-mono" required />
          <input name="customerAccountId" placeholder="customer_account_id" className="w-40 font-mono" />
          <Button tone="primary">Add account</Button>
        </form>
      </Card>

      <Card id="thresholds" title="Thresholds">
        <form action={saveThresholds} className="grid gap-2 sm:grid-cols-2">
          {(Object.keys(THRESHOLD_LABELS) as (keyof typeof DEFAULT_SETTINGS)[]).map((k) => {
            const v = settings[k];
            return (
              <label key={k} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-muted">{THRESHOLD_LABELS[k]}</span>
                <input name={k} defaultValue={Array.isArray(v) ? v.join(", ") : String(v)} className={typeof v === "number" ? "w-20 text-right" : "w-56"} />
              </label>
            );
          })}
          <div><Button tone="primary">Save thresholds</Button></div>
        </form>
      </Card>

      <Card id="jobs" title="Jobs">
        <AutoRefresh active={runs.some((r) => r.ok === null)} />
        <p className="mb-2 text-xs text-muted">Jobs run in the background (up to ~4 minutes each). You can leave this page; big first runs pick up where they stopped next time.</p>
        <div className="mb-3 flex flex-wrap gap-2">
          {JOBS.map((j) => {
            const missing = j.ready();
            const running = runs.some((r) => r.job === j.name && r.ok === null);
            return (
              <form key={j.name} action={runJobNow} className="flex items-center gap-2 rounded border border-line px-2 py-1 text-sm">
                <input type="hidden" name="job" value={j.name} />
                <span title={j.description}>{j.title}</span>
                <span className="text-xs text-muted">{j.schedule}</span>
                <RunButton running={running} disabledReason={missing} />
              </form>
            );
          })}
        </div>
        <div className="divide-y divide-line text-sm">
          {runs.length === 0 && <p className="text-muted">No runs yet.</p>}
          {runs.map((r) => (
            <details key={r.id} className="py-1.5">
              <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                {(() => {
                  const partial = r.ok && (r.stats as { incomplete?: boolean } | null)?.incomplete === true;
                  if (r.ok === null) return <Pill tone="info">running…</Pill>;
                  if (!r.ok) return <Pill tone="red">failed</Pill>;
                  return partial ? <Pill tone="yellow">partly done · run again</Pill> : <Pill tone="green">done</Pill>;
                })()}
                <span className="font-medium">{r.job}</span>
                <span className="text-muted">{fmtDateTime(r.startedAt)}</span>
                {r.finishedAt && <span className="text-muted">{((r.finishedAt.getTime() - r.startedAt.getTime()) / 1000).toFixed(1)}s</span>}
                <span className="text-xs text-muted">{r.trigger}</span>
                {r.error && <span className="text-red-600">{r.error}</span>}
              </summary>
              {r.stats && <pre className="mt-1 overflow-x-auto rounded bg-bg p-2 text-xs">{JSON.stringify(r.stats, null, 2)}</pre>}
            </details>
          ))}
        </div>
      </Card>
    </div>
  );
}

function Conn({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <li className="flex flex-wrap items-center gap-2">
      <Pill tone={ok ? "green" : "red"}>{ok ? "connected" : "not set"}</Pill>
      <span className="font-medium">{label}</span>
      <span className="text-muted">{detail}</span>
    </li>
  );
}

type StoreWithManager = Prisma.StoreGetPayload<{ include: { manager: true } }>;

function StoreRowView({ s, accounts }: { s: StoreWithManager; accounts: ShipheroAccount[] }) {
  return (
    <div className="flex flex-wrap items-start gap-2 py-2">
      <form action={toggleStore} className="pt-1">
        <input type="hidden" name="id" value={s.id} />
        <button title={s.enabled ? "Enabled: click to disable" : "Disabled: click to enable"} className={`h-5 w-9 rounded-full p-0.5 ${s.enabled ? "bg-emerald-600" : "bg-neutral-400"}`}>
          <span className={`block h-4 w-4 rounded-full bg-white transition ${s.enabled ? "translate-x-4" : ""}`} />
        </button>
      </form>
      <form action={saveStore} className="flex flex-1 flex-wrap items-center gap-2">
        <input type="hidden" name="id" value={s.id} />
        <input name="name" defaultValue={s.name} className="w-44 font-medium" aria-label="Name" />
        <input name="code" defaultValue={s.code ?? ""} placeholder="Our code" title="Mainfactor store code" className="w-20 font-mono" />
        <input name="skuPrefixes" defaultValue={s.skuPrefixes.join(", ")} placeholder="Global SKU prefix" title="Global's SKU prefix(es), comma separated" className={`w-36 font-mono ${s.skuPrefixes.length ? "" : "border-amber-400"}`} />
        <input name="manager" defaultValue={s.manager?.email ?? s.manager?.name ?? ""} placeholder="MF manager" className="w-36" list="managers" />
        <span className="flex flex-wrap gap-1 text-xs text-muted">
          {s.closed && <Pill tone="gray">closed</Pill>}
          {s.tier && <Pill tone="gray">Tier {s.tier}</Pill>}
          {s.warehouseName && <span>{s.warehouseName}</span>}
          {s.globalManager && <span>· Global: {s.globalManager}</span>}
        </span>
        <div className="flex w-full flex-wrap items-center gap-2">
          <input name="warehouseName" defaultValue={s.warehouseName ?? ""} placeholder="Warehouse" list="warehouse-names" className={`w-44 ${s.warehouseName ? "" : "border-amber-400"}`} title="Where the store ships from, e.g. Mainfactor Michigan" />
          {(() => {
            const a = accountForStore(s, accounts);
            if (!a) return <Pill tone="yellow">No ShipHero account for this warehouse</Pill>;
            if (!tokenSet(a)) return <Pill tone="gray">ShipHero: {a.name} (token not set)</Pill>;
            return s.shipheroWarehouseId
              ? <Pill tone="green">ShipHero: {a.name} · matched</Pill>
              : <Pill tone="yellow">ShipHero: no profile match yet</Pill>;
          })()}
          <input name="shipheroProfile" defaultValue={s.shipheroProfile ?? ""} placeholder={`ShipHero profile (default: ${s.name})`} list="shiphero-profiles" className="w-56" title="Only if the ShipHero warehouse profile is named differently from the store" />
          <input name="asanaProjectId" defaultValue={s.asanaProjectId ?? ""} placeholder="Asana E-Comm project ID" className="w-44" />
          <Button>Save</Button>
        </div>
      </form>
      <form action={deleteStore}>
        <input type="hidden" name="id" value={s.id} />
        <Button tone="danger">Delete</Button>
      </form>
    </div>
  );
}

function TokenPill({ tokenRef }: { tokenRef: string }) {
  const raw = process.env[tokenRef];
  if (!raw) return <Pill tone="gray">token not set</Pill>;
  const info = tokenInfo(raw);
  if (info.kind === "refresh") return <Pill tone="green">refresh token set</Pill>;
  if (!info.expiresAt) return <Pill tone="yellow">access token (expiry unknown)</Pill>;
  const days = Math.floor((info.expiresAt.getTime() - Date.now()) / 86400000);
  const when = info.expiresAt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return <Pill tone={days < 0 ? "red" : days < 7 ? "yellow" : "green"}>{days < 0 ? `access token expired ${when}` : `access token · expires ${when}`}</Pill>;
}
