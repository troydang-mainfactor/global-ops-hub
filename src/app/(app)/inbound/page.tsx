import { db } from "@/lib/db";
import { STAGES, STAGE_LABEL, type Stage } from "@/lib/stages";
import { Card, Pill, daysSince, fmtDate } from "@/components/ui";
import { trackingUrl } from "@/lib/tracking";
import { accountForStore, tokenSet } from "@/lib/shiphero/accounts";

// Basic list so ingest results can be checked now. The full Inbound screen (§8.2) comes in Phase 1 step 3.
export default async function Inbound() {
  const pos = await db.purchaseOrder.findMany({
    where: { store: { enabled: true } },
    include: { store: true, lines: true },
    orderBy: [{ issuedAt: "desc" }, { shippedAt: "desc" }],
  });
  const names = await db.product.findMany({ where: { sku: { in: [...new Set(pos.flatMap((p) => p.lines.map((l) => l.productSku)))] } }, select: { sku: true, name: true } });
  const nameOf = new Map(names.map((n) => [n.sku, n.name]));

  // For POs not matched in ShipHero: which login was searched, and ShipHero POs with a similar number.
  const accounts = await db.shipheroAccount.findMany();
  const unmatched = pos.filter((p) => !p.shipheroId);
  const shPos = unmatched.length
    ? await db.shipheroPo.findMany({ select: { poNumber: true, accountId: true, fulfillmentStatus: true } })
    : [];
  const lastSync = await db.syncRun.findFirst({ where: { job: "shiphero-sync", ok: true }, orderBy: { startedAt: "desc" } });
  const digits = (s: string) => s.replace(/\D/g, "").replace(/^0+/, "");
  const whyUnmatched = (p: (typeof pos)[number]) => {
    const acct = p.store ? accountForStore(p.store, accounts) : null;
    if (!acct) return `No ShipHero login for ${p.store?.warehouseName ?? "this store's warehouse"}`;
    if (!tokenSet(acct)) return `${acct.name} ShipHero login not connected yet (token not set)`;
    const want = digits(p.orderNo);
    const similar = shPos.filter((s) => s.accountId === acct.id && want.length >= 4 && digits(s.poNumber).includes(want)).slice(0, 3);
    const searched = `Searched ${acct.name} (${shPos.filter((s) => s.accountId === acct.id).length} POs from the last ${lastSync ? `sync ${fmtDate(lastSync.startedAt)}` : "sync: none yet"})`;
    return similar.length
      ? `${searched}. Similar: ${similar.map((s) => `${s.poNumber} (${s.fulfillmentStatus ?? "?"})`).join(", ")}`
      : `${searched}. None with ${p.orderNo} yet`;
  };

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Inbound <span className="text-sm font-normal text-muted">{pos.length} POs</span></h1>
      {STAGES.map((stage) => {
        const list = pos.filter((p) => p.stage === stage);
        if (!list.length) return null;
        return (
          <Card key={stage} title={<>{STAGE_LABEL[stage as Stage]} <span className="text-sm font-normal text-muted">{list.length}</span></>}>
            <ul className="divide-y divide-line text-sm">
              {list.map((p) => {
                const skus = [...new Set(p.lines.map((l) => l.productSku))];
                const ordered = p.lines.reduce((a, l) => a + (l.qtyShiphero ?? l.qtyOrdered ?? 0), 0);
                const received = p.lines.reduce((a, l) => a + l.qtyReceived, 0);
                const since = stage === "issued" ? p.issuedAt : p.shippedAt ?? p.issuedAt;
                return (
                  <li key={p.id} className="py-2">
                    <details>
                      <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="font-mono font-medium">{p.orderNo}</span>
                        <span className="text-muted">{p.store?.code ?? p.store?.name}</span>
                        <span className="font-mono text-xs">{skus.join(", ")}</span>
                        <span className="truncate">{skus.map((s) => nameOf.get(s)).filter(Boolean).join(" · ")}</span>
                        <span className="text-muted">{p.warehouseCode}</span>
                        <span className="ml-auto flex items-center gap-2">
                          <span className="text-xs text-muted">{daysSince(since) ?? "—"}d in stage</span>
                          {p.etaAt && <Pill tone="info">ETA {fmtDate(p.etaAt)} · {p.etaSource}</Pill>}
                          {ordered > 0 && (
                            <span className="flex items-center gap-1 text-xs" title="received / ordered">
                              <span className="h-1.5 w-16 overflow-hidden rounded bg-line">
                                <span className="block h-full bg-emerald-600" style={{ width: `${Math.min(100, (received / ordered) * 100)}%` }} />
                              </span>
                              {received}/{ordered}
                            </span>
                          )}
                        </span>
                      </summary>
                      <div className="mt-2 grid gap-2 pl-2 text-xs sm:grid-cols-2">
                        <div>
                          <div className="text-muted">Lines</div>
                          {p.lines.map((l) => (
                            <div key={l.id} className="font-mono">
                              {l.variantSku ?? l.productSku}{" "}
                              {(l.qtyShiphero ?? l.qtyOrdered) != null && `${l.qtyReceived}/${l.qtyShiphero ?? l.qtyOrdered}`}
                              {l.qtyOrdered != null && l.qtyShiphero != null && l.qtyOrdered !== l.qtyShiphero && <span className="text-amber-600"> (PDF {l.qtyOrdered})</span>}
                            </div>
                          ))}
                          {!p.pdfJson && <div className="text-muted">{p.pdfSource ? (p.pdfError ? `PDF failed: ${p.pdfError}` : "PDF not parsed yet") : "No PO PDF found"}</div>}
                        </div>
                        <div className="space-y-1">
                          <div><span className="text-muted">Issued</span> {fmtDate(p.issuedAt)} · <span className="text-muted">Shipped</span> {fmtDate(p.shippedAt)}</div>
                          {p.tracking.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {p.tracking.map((t) => (
                                <a key={t} className="font-mono underline" target="_blank" rel="noreferrer" href={trackingUrl(t)}>{t}</a>
                              ))}
                            </div>
                          )}
                          {p.receivedAt && <div><span className="text-muted">Received</span> {fmtDate(p.receivedAt)}</div>}
                          <div>
                            <span className="text-muted">ShipHero</span>{" "}
                            {p.shipheroId
                              ? `matched${p.shipheroId.includes(",") ? ` (${p.shipheroId.split(",").length} POs, one per SKU)` : ""}`
                              : <span className="text-amber-600">not matched. {whyUnmatched(p)}</span>}
                          </div>
                          {p.productionTaskUrl && <a className="underline" href={p.productionTaskUrl} target="_blank" rel="noreferrer">Production task</a>}
                        </div>
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>
          </Card>
        );
      })}
      {pos.length === 0 && <Card><p className="text-sm text-muted">No POs for enabled stores yet.</p></Card>}
    </div>
  );
}

