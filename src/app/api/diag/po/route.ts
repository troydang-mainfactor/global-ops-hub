// Read-only matching diagnostics for one order number or SKU.
// GET /api/diag/po?no=PO092040&key=$DIAG_KEY  (or &sku=CHELNR003120OT). Disabled unless DIAG_KEY is set.
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { orderKey } from "@/lib/shiphero/sync";
import { currentUserEmail } from "@/lib/auth";

export const dynamic = "force-dynamic";

function keyOk(got: string | null): boolean {
  const want = process.env.DIAG_KEY;
  if (!want || !got || got.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (!keyOk(url.searchParams.get("key")) && !(await currentUserEmail())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const no = (url.searchParams.get("no") ?? "").toUpperCase().trim();
  const sku = (url.searchParams.get("sku") ?? "").toUpperCase().trim();
  const digits = no.replace(/\D/g, "").replace(/^0+/, "");

  const local = await db.purchaseOrder.findMany({
    where: no ? { orderNo: { contains: digits } } : { lines: { some: { productSku: { startsWith: sku } } } },
    include: { lines: true, store: true },
    take: 20,
  });
  const emails = await db.emailMessage.findMany({
    where: { OR: [no ? { subject: { contains: digits } } : {}, sku ? { subject: { contains: sku } } : {}].filter((w) => Object.keys(w).length) },
    select: { id: true, subject: true, status: true, skipReason: true, parsedBy: true, error: true, storeCode: true, baseSku: true, receivedAt: true },
    take: 40,
  });
  const allSh = await db.shipheroPo.findMany();
  const sh = allSh
    .filter((p) => (digits && p.poNumber.replace(/\D/g, "").includes(digits)) || (sku && JSON.stringify(p.lines).toUpperCase().includes(sku)))
    .slice(0, 30)
    .map((p) => ({ id: p.id, poNumber: p.poNumber, key: orderKey(p.poNumber), accountId: p.accountId, warehouseId: p.warehouseId, status: p.fulfillmentStatus, poDate: p.poDate, dateClosed: p.dateClosed, lines: p.lines, syncedAt: p.syncedAt }));
  const states = await db.syncState.findMany({ where: { key: { startsWith: "sh:" } } });
  const runs = await db.syncRun.findMany({ where: { job: "shiphero-sync" }, orderBy: { startedAt: "desc" }, take: 5 });
  const issues = await db.issue.findMany({ where: { OR: [{ title: { contains: digits || "∅" } }, { title: { contains: sku || "∅" } }] }, take: 20 });

  return NextResponse.json({
    query: { no, sku, digits, key: orderKey(no) },
    shipheroPoCacheSize: allSh.length,
    local: local.map((p) => ({
      id: p.id, orderNo: p.orderNo, key: orderKey(p.orderNo), stage: p.stage, warehouseCode: p.warehouseCode, shipheroId: p.shipheroId,
      store: p.store && { name: p.store.name, enabled: p.store.enabled, warehouseName: p.store.warehouseName, shipheroWarehouseId: p.store.shipheroWarehouseId, shipheroProfile: p.store.shipheroProfile, shipheroAccountId: p.store.shipheroAccountId },
      lines: p.lines.map((l) => ({ key: l.lineKey, ordered: l.qtyOrdered, sh: l.qtyShiphero, rec: l.qtyReceived })),
    })),
    emails, shipheroPos: sh,
    syncStates: states.map((s) => ({ key: s.key, value: s.key.startsWith("sh:wh:") ? { count: (s.value as { count?: number })?.count } : s.value, updatedAt: s.updatedAt })),
    recentShipheroRuns: runs.map((r) => ({ startedAt: r.startedAt, ok: r.ok, error: r.error, stats: r.stats })),
    issues: issues.map((i) => ({ ruleId: i.ruleId, status: i.status, title: i.title, detail: i.detail })),
  });
}
