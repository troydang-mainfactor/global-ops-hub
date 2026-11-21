import { db } from "@/lib/db";
import { Button, Card, Pill, fmtDate, fmtDateTime } from "@/components/ui";
import { updateIssue } from "./issue-actions";

const SEV_ORDER = ["red", "yellow", "info"] as const;
const SEV_LABEL = { red: "Needs action", yellow: "Check", info: "FYI" };

export default async function Today() {
  const now = new Date();
  const weekAhead = new Date(now.getTime() + 7 * 86400000);
  const [issues, arriving, received, pos] = await Promise.all([
    db.issue.findMany({
      where: { OR: [{ status: "open" }, { status: "snoozed", snoozedUntil: { lte: now } }] },
      orderBy: [{ lastSeen: "desc" }],
      take: 200,
    }),
    db.purchaseOrder.findMany({ where: { stage: "shipped", etaAt: { lte: weekAhead } }, orderBy: { etaAt: "asc" }, include: { lines: true, store: true } }),
    db.purchaseOrder.count({ where: { receivedAt: { gte: new Date(now.getTime() - 7 * 86400000) } } }),
    db.purchaseOrder.count(),
  ]);
  const red = issues.filter((i) => i.severity === "red").length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Needs action" value={red} tone={red ? "red" : undefined} />
        <Tile label="Arriving this week" value={arriving.length} />
        <Tile label="Just received" value={received} hint="needs ShipHero sync" />
        <Tile label="Launches at risk" value="—" hint="Phase 2" />
      </div>

      {pos === 0 && (
        <Card>
          <p className="text-sm">No POs yet. Set up stores and warehouses in <a className="underline" href="/settings">Settings</a>, then run <b>Gmail backfill</b>.</p>
        </Card>
      )}

      <Card title="Arriving soon">
        {arriving.length === 0 ? (
          <p className="text-sm text-muted">Nothing shipped with an ETA in the next 7 days.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {arriving.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 py-1.5">
                <span className="font-mono">{p.orderNo}</span>
                <span className="text-muted">{p.store?.code ?? p.store?.name}</span>
                <span className="font-mono text-xs">{[...new Set(p.lines.map((l) => l.productSku))].join(", ")}</span>
                <span className="ml-auto">ETA {fmtDate(p.etaAt)} <span className="text-xs text-muted">({p.etaSource})</span></span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`Issues (${issues.length})`}>
        {issues.length === 0 && <p className="text-sm text-muted">No open issues.</p>}
        {SEV_ORDER.map((sev) => {
          const list = issues.filter((i) => i.severity === sev);
          if (!list.length) return null;
          return (
            <div key={sev} className="mb-4">
              <h3 className="mb-1 text-sm font-medium"><Pill tone={sev}>{SEV_LABEL[sev]}</Pill> <span className="text-muted">{list.length}</span></h3>
              <ul className="divide-y divide-line">
                {list.map((i) => {
                  const ev = (i.evidence ?? {}) as Record<string, unknown>;
                  return (
                    <li key={i.id} className="py-2 text-sm">
                      <details>
                        <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                          <span className="font-mono text-xs text-muted">{i.ruleId}</span>
                          <span>{i.title}</span>
                          {i.byAi && <Pill tone="info">possible issue</Pill>}
                          <span className="ml-auto text-xs text-muted">{fmtDateTime(i.lastSeen)}</span>
                        </summary>
                        <div className="mt-2 space-y-2 pl-2">
                          <p className="text-muted">{i.detail}</p>
                          <p className="flex flex-wrap gap-2 text-xs">
                            {Object.entries(ev).map(([k, v]) =>
                              typeof v === "string" && v.startsWith("http") ? (
                                <a key={k} href={v} target="_blank" rel="noreferrer" className="underline">{k}</a>
                              ) : typeof v === "string" || typeof v === "number" ? (
                                <span key={k}><span className="text-muted">{k}:</span> {String(v)}</span>
                              ) : null,
                            )}
                          </p>
                          <form action={updateIssue} className="flex flex-wrap items-center gap-2">
                            <input type="hidden" name="id" value={i.id} />
                            <input name="reason" placeholder="Reason (required to dismiss)" className="w-64" />
                            <Button name="action" value="resolve">Resolve</Button>
                            <Button name="action" value="snooze">Snooze 7d</Button>
                            <Button name="action" value="dismiss" tone="danger">Dismiss</Button>
                          </form>
                        </div>
                      </details>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </Card>
    </div>
  );
}

function Tile({ label, value, tone, hint }: { label: string; value: number | string; tone?: string; hint?: string }) {
  return (
    <div className={`rounded-lg border border-line bg-card p-3 ${tone === "red" ? "border-red-300" : ""}`}>
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-2xl font-semibold ${tone === "red" ? "text-red-600" : ""}`}>{value}</div>
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}
