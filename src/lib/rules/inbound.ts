// Inbound checks that run after every Gmail ingest and ShipHero sync (SPEC §7).
// Each check raises/refreshes an Issue; issues whose condition no longer holds are resolved.
import type { Db } from "../db";
import { raiseIssue } from "../issues";
import { getSettings } from "../settings";
import { accountForStore } from "../shiphero/accounts";

const RULES = ["R01", "R18", "R19"] as const;
const DAY = 86400000;

export async function runInboundRules(db: Db, now = new Date()) {
  const settings = await getSettings(db);
  const raised = new Set<string>();
  const raise = async (i: Parameters<typeof raiseIssue>[1]) => {
    raised.add(i.fingerprint);
    await raiseIssue(db, i, now);
  };

  const accounts = await db.shipheroAccount.findMany();
  const pos = await db.purchaseOrder.findMany({
    where: { store: { enabled: true }, stage: { not: "closed" } },
    include: { lines: true, store: true },
  });
  // Warehouses whose inventory has been read in full at least once (so "not in ShipHero" is trustworthy).
  const wpStates = await db.syncState.findMany({ where: { key: { startsWith: "sh:wp:" } } });
  const poWarehouses = new Map<string, string[]>();
  for (const r of await db.shipheroPo.findMany({ where: { warehouseId: { not: null } }, distinct: ["accountId", "warehouseId"], select: { accountId: true, warehouseId: true } })) {
    poWarehouses.set(r.accountId, [...(poWarehouses.get(r.accountId) ?? []), r.warehouseId!]);
  }
  // Logins that have synced at least once (warehouse list saved).
  const syncedAccounts = new Set((await db.syncState.findMany({ where: { key: { startsWith: "sh:wh:" } }, select: { key: true } })).map((s) => s.key.slice(6)));
  const inventoryReady = new Set(
    wpStates.filter((s) => (s.value as { updatedFrom?: string | null })?.updatedFrom).map((s) => s.key.split(":").slice(2).join(":")),
  );

  for (const po of pos) {
    const store = po.store!;
    const acct = accountForStore(store, accounts);
    const connected = Boolean(acct && syncedAccounts.has(acct.id));
    const ordered = po.lines.reduce((a, l) => a + (l.qtyShiphero ?? l.qtyOrdered ?? 0), 0);
    const received = po.lines.reduce((a, l) => a + l.qtyReceived, 0);
    const rejected = po.lines.reduce((a, l) => a + l.qtyRejected, 0);
    const short = po.lines
      .filter((l) => (l.qtyShiphero ?? l.qtyOrdered ?? 0) > l.qtyReceived + l.qtyRejected)
      .map((l) => `${l.variantSku ?? l.productSku} ${l.qtyReceived}/${l.qtyShiphero ?? l.qtyOrdered}`);

    // R18: part received, then nothing for N days, or ShipHero closed it short.
    if (po.shipheroId && received > 0 && received + rejected < ordered) {
      const closedShort = Boolean(po.shipheroClosedAt);
      const stalledFor = po.receivedChangedAt ? Math.floor((now.getTime() - po.receivedChangedAt.getTime()) / DAY) : 0;
      if (closedShort || stalledFor >= settings.partialReceiptStallDays) {
        await raise({
          ruleId: "R18", severity: "red",
          title: `${po.orderNo} ${store.name}: ${closedShort ? "closed short" : "short shipment?"} ${received} of ${ordered} received`,
          detail: `${closedShort ? "ShipHero closed this PO before everything arrived." : `Receiving stopped ${stalledFor} days ago.`} Missing: ${short.slice(0, 12).join(", ")}${short.length > 12 ? "…" : ""}. Chase the vendor or check the launch for these SKUs.`,
          fingerprint: `R18:${po.id}`, poId: po.id, productSku: po.lines[0]?.productSku ?? null,
          evidence: { orderNo: po.orderNo, received, ordered, short, closedAt: po.shipheroClosedAt?.toISOString() ?? null },
        });
      }
    }

    if (!po.shipheroId && connected) {
      // R19: the product doesn't exist in ShipHero yet, so the PO can't be created there.
      // Trust "not in ShipHero" only once every warehouse that receives POs has been read in full.
      const poWh = poWarehouses.get(acct!.id) ?? [];
      const ready = poWh.length > 0 && poWh.every((wh) => inventoryReady.has(`${acct!.id}:${wh}`));
      const missing: string[] = [];
      if (ready) {
        for (const sku of [...new Set(po.lines.map((l) => l.productSku))]) {
          const n = await db.variant.count({ where: { productSku: sku, inShiphero: true, shipheroAccountId: acct!.id } });
          if (!n) missing.push(sku);
        }
        for (const sku of missing) {
          await raise({
            ruleId: "R19", severity: "yellow",
            title: `${sku} (${store.name}) isn't in ShipHero: create the product for ${po.orderNo}`,
            detail: `No ShipHero product with this SKU in the ${acct!.name} login, so the PO can't be received. Create it (with its sizes) in ShipHero.`,
            fingerprint: `R19:${po.id}:${sku}`, poId: po.id, productSku: sku,
            evidence: { orderNo: po.orderNo, sku, store: store.name },
          });
        }
      }
      // R01: issued more than N hours ago and still no ShipHero PO.
      const hours = po.issuedAt ? (now.getTime() - po.issuedAt.getTime()) / 3600000 : 0;
      if (po.stage === "issued" && hours >= settings.issuedNoShipheroHours) {
        await raise({
          ruleId: "R01", severity: "yellow",
          title: `${po.orderNo} ${store.name}: issued ${Math.floor(hours / 24)}d ago, not in ShipHero`,
          detail: `No ShipHero PO ending in ${po.orderNo} yet.${missing.length ? ` The product isn't in ShipHero either (${missing.join(", ")}).` : ""}`,
          fingerprint: `R01:${po.id}`, poId: po.id, productSku: po.lines[0]?.productSku ?? null,
          evidence: { orderNo: po.orderNo, issuedAt: po.issuedAt?.toISOString() ?? null },
        });
      }
    }
  }

  // Resolve open issues from these checks that no longer apply.
  const open = await db.issue.findMany({ where: { ruleId: { in: [...RULES] }, status: { in: ["open", "snoozed"] } }, select: { id: true, fingerprint: true } });
  const gone = open.filter((i) => !raised.has(i.fingerprint)).map((i) => i.id);
  if (gone.length) await db.issue.updateMany({ where: { id: { in: gone } }, data: { status: "resolved", resolution: "No longer applies" } });
  return { raised: raised.size, resolved: gone.length };
}
