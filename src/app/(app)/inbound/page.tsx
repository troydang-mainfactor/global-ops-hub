import { db } from "@/lib/db";
import { STAGES, STAGE_LABEL, type Stage } from "@/lib/stages";
import { Card, Pill, daysSince, fmtDate } from "@/components/ui";

// Basic list so ingest results can be checked now. The full Inbound screen (§8.2) comes in Phase 1 step 3.
export default async function Inbound() {
  const pos = await db.purchaseOrder.findMany({
    where: { store: { enabled: true } },
    include: { store: true, lines: true },
    orderBy: [{ issuedAt: "desc" }, { shippedAt: "desc" }],
  });
  const names = await db.product.findMany({ where: { sku: { in: [...new Set(pos.flatMap((p) => p.lines.map((l) => l.productSku)))] } }, select: { sku: true, name: true } });
  const nameOf = new Map(names.map((n) => [n.sku, n.name]));

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
                const ordered = p.lines.reduce((a, l) => a + (l.qtyOrdered ?? 0), 0);
                const since = stage === "issued" ? p.issuedAt : p.shippedAt ?? p.issuedAt;
                return (
                  <li key={p.id} className="py-2">
                    <details>
                      <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="font-mono font-medium">{p.orderNo}</span>
                        <span className="text-muted">{p.store?.code}</span>
                        <span className="font-mono text-xs">{skus.join(", ")}</span>
                        <span className="truncate">{skus.map((s) => nameOf.get(s)).filter(Boolean).join(" · ")}</span>
                        <span className="text-muted">{p.warehouseCode}</span>
                        <span className="ml-auto flex items-center gap-2">
                          <span className="text-xs text-muted">{daysSince(since) ?? "—"}d in stage</span>
                          {p.etaAt && <Pill tone="info">ETA {fmtDate(p.etaAt)} · {p.etaSource}</Pill>}
                          {ordered > 0 && <span className="text-xs">{p.lines.reduce((a, l) => a + l.qtyReceived, 0)}/{ordered}</span>}
                        </span>
                      </summary>
                      <div className="mt-2 grid gap-2 pl-2 text-xs sm:grid-cols-2">
                        <div>
                          <div className="text-muted">Lines</div>
                          {p.lines.map((l) => (
                            <div key={l.id} className="font-mono">{l.variantSku ?? l.productSku} {l.qtyOrdered != null && `× ${l.qtyOrdered}`}</div>
                          ))}
                          {!p.pdfJson && <div className="text-muted">{p.pdfSource ? (p.pdfError ? `PDF failed: ${p.pdfError}` : "PDF not parsed yet") : "No PO PDF found"}</div>}
                        </div>
                        <div className="space-y-1">
                          <div><span className="text-muted">Issued</span> {fmtDate(p.issuedAt)} · <span className="text-muted">Shipped</span> {fmtDate(p.shippedAt)}</div>
                          {p.tracking.length > 0 && (
                            <div className="flex flex-wrap gap-1">
                              {p.tracking.map((t) => (
                                <a key={t} className="font-mono underline" target="_blank" rel="noreferrer" href={t.startsWith("1Z") ? `https://www.ups.com/track?tracknum=${t}` : `https://www.google.com/search?q=${t}`}>{t}</a>
                              ))}
                            </div>
                          )}
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
