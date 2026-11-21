import { db } from "@/lib/db";
import { getSettings, DEFAULT_SETTINGS } from "@/lib/settings";
import { JOBS } from "@/lib/jobs/registry";
import { gmailConfigured, gmailLabelsEnabled } from "@/lib/gmail/client";
import { aiConfigured, aiModel } from "@/lib/ai/client";
import { Button, Card, Pill, fmtDateTime } from "@/components/ui";
import {
  deleteShipheroAccount, deleteStore, deleteWarehouse, enableManagerStores, importStores, runJobNow,
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

export default async function SettingsPage() {
  const [stores, users, warehouses, accounts, settings, runs, unmatched] = await Promise.all([
    db.store.findMany({ include: { manager: true }, orderBy: [{ enabled: "desc" }, { code: "asc" }] }),
    db.user.findMany({ orderBy: { name: "asc" } }),
    db.warehouse.findMany({ orderBy: { emailCode: "asc" } }),
    db.shipheroAccount.findMany({ orderBy: { name: "asc" } }),
    getSettings(db),
    db.syncRun.findMany({ orderBy: { startedAt: "desc" }, take: 20 }),
    db.emailMessage.groupBy({ by: ["baseSku"], where: { status: "skipped", skipReason: "unknown_store" }, _count: true, orderBy: { _count: { baseSku: "desc" } }, take: 30 }),
  ]);
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
        <p className="mb-3 text-sm text-muted">The code is the SKU prefix. Each store has its own ShipHero account and warehouse; its POs are matched there. Only enabled stores are processed. Turning a store on applies its already-seen emails on the next run.</p>
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
          {stores.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-2 py-2">
              <form action={toggleStore}>
                <input type="hidden" name="id" value={s.id} />
                <button title="Toggle" className={`h-5 w-9 rounded-full p-0.5 ${s.enabled ? "bg-emerald-600" : "bg-neutral-400"}`}>
                  <span className={`block h-4 w-4 rounded-full bg-white transition ${s.enabled ? "translate-x-4" : ""}`} />
                </button>
              </form>
              <form action={saveStore} className="flex flex-1 flex-wrap items-center gap-2">
                <input type="hidden" name="id" value={s.id} />
                <input name="code" defaultValue={s.code} className="w-20 font-mono" aria-label="Code" />
                <input name="name" defaultValue={s.name} className="w-40" aria-label="Name" />
                <input name="manager" defaultValue={s.manager?.email ?? s.manager?.name ?? ""} placeholder="Manager (name or email)" className="w-44" list="managers" />
                <select name="shipheroAccountId" defaultValue={s.shipheroAccountId ?? ""} aria-label="ShipHero account">
                  <option value="">ShipHero account…</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <input name="shipheroWarehouseId" defaultValue={s.shipheroWarehouseId ?? ""} placeholder="ShipHero warehouse ID" className="w-44 font-mono" />
                <input name="asanaProjectId" defaultValue={s.asanaProjectId ?? ""} placeholder="Asana E-Comm project ID" className="w-44" />
                <Button>Save</Button>
              </form>
              <form action={deleteStore}>
                <input type="hidden" name="id" value={s.id} />
                <Button tone="danger">Delete</Button>
              </form>
            </div>
          ))}
        </div>
        <datalist id="managers">{users.map((u) => <option key={u.id} value={u.email ?? u.name} />)}</datalist>
        <form action={saveStore} className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <input name="code" placeholder="CODE" className="w-20 font-mono" required />
          <input name="name" placeholder="Store name" className="w-40" required />
          <input name="manager" placeholder="Manager" className="w-44" list="managers" />
          <label className="flex items-center gap-1 text-sm"><input type="checkbox" name="enabled" /> Enabled</label>
          <Button tone="primary">Add store</Button>
        </form>
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-muted">Import store list (store, store_code, manager)</summary>
          <form action={importStores} className="mt-2 space-y-2">
            <textarea name="csv" rows={6} className="w-full font-mono text-xs" placeholder={"store,store_code,manager\nStokes Official,STOK,Troy Dang"} />
            <Button tone="primary">Import (new stores start disabled)</Button>
          </form>
        </details>
        {unmatched.length > 0 && (
          <div className="mt-3 border-t border-line pt-3 text-sm">
            <p className="text-muted">SKUs seen in PO emails with no matching store code (add the store to pick them up):</p>
            <p className="mt-1 flex flex-wrap gap-1 font-mono text-xs">
              {unmatched.map((u) => <span key={u.baseSku} className="rounded bg-bg px-1.5 py-0.5">{u.baseSku} ×{u._count}</span>)}
            </p>
          </div>
        )}
      </Card>

      <Card id="warehouses" title="Warehouse codes">
        <p className="mb-3 text-sm text-muted">Codes seen in the PO emails. The ShipHero account and warehouse are set per store (above). Untick &quot;In ShipHero&quot; for a warehouse that isn&apos;t tracked in ShipHero.</p>
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
        <p className="mb-3 text-sm text-muted">Store only the <b>name</b> of the env var holding each refresh token (e.g. SHIPHERO_TOKEN_MAIN). 3PL accounts also need the customer account ID.</p>
        <div className="divide-y divide-line">
          {accounts.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center gap-2 py-2">
              <form action={saveShipheroAccount} className="flex flex-1 flex-wrap items-center gap-2">
                <input type="hidden" name="id" value={a.id} />
                <input name="name" defaultValue={a.name} className="w-40" />
                <select name="type" defaultValue={a.type}><option value="direct">direct</option><option value="3pl">3pl</option></select>
                <input name="tokenRef" defaultValue={a.tokenRef} className="w-52 font-mono" />
                <input name="customerAccountId" defaultValue={a.customerAccountId ?? ""} placeholder="customer_account_id" className="w-40 font-mono" />
                {process.env[a.tokenRef] ? <Pill tone="green">token set</Pill> : <Pill tone="red">env var missing</Pill>}
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
        <div className="mb-3 flex flex-wrap gap-2">
          {JOBS.map((j) => {
            const missing = j.ready();
            return (
              <form key={j.name} action={runJobNow} className="flex items-center gap-2 rounded border border-line px-2 py-1 text-sm">
                <input type="hidden" name="job" value={j.name} />
                <span title={j.description}>{j.title}</span>
                <span className="text-xs text-muted">{j.schedule}</span>
                <Button tone="primary" disabled={Boolean(missing)} title={missing ?? "Run now"}>Run now</Button>
              </form>
            );
          })}
        </div>
        <div className="divide-y divide-line text-sm">
          {runs.length === 0 && <p className="text-muted">No runs yet.</p>}
          {runs.map((r) => (
            <details key={r.id} className="py-1.5">
              <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                <Pill tone={r.ok === null ? "gray" : r.ok ? "green" : "red"}>{r.ok === null ? "running" : r.ok ? "ok" : "failed"}</Pill>
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
