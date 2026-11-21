import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ShipheroClient } from "@/lib/shiphero/client";
import { runShipheroSync } from "@/lib/shiphero/sync";
import { hasTestDb, resetDb, testDb } from "./helpers/db";

const NOW = new Date("2026-11-21T12:00:00Z");

interface FakeData {
  warehouses?: { id: string; identifier: string; profile: string | null; active: boolean }[];
  pos?: Array<{ id: string; po_number: string; status?: string; date_closed?: string | null; lines: [string, number, number][] }>;
  wps?: Array<{ sku: string; on_hand: number; available: number; allocated: number; backorder: number; name?: string }>;
  tagged?: Array<{ sku: string; tags: string[] }>;
}

function fakeShiphero(d: FakeData) {
  const queries: string[] = [];
  const page = <T,>(nodes: T[]) => ({ request_id: "r", complexity: 1, data: { pageInfo: { hasNextPage: false, endCursor: null }, edges: nodes.map((node) => ({ node })) } });
  const client: ShipheroClient & { queries: string[] } = {
    queries,
    async query<T>(q: string) {
      queries.push(q);
      if (q.includes("account {")) return { account: { data: { id: "A", is_3pl: false, warehouses: d.warehouses ?? [{ id: "WH1", identifier: "Primary", profile: "Sleep Token", active: true }] } } } as T;
      if (q.includes("purchase_orders(")) {
        return { purchase_orders: page((d.pos ?? []).map((p) => ({
          id: p.id, legacy_id: 123, po_number: p.po_number, warehouse_id: "WH1", fulfillment_status: p.status ?? "pending", po_date: null, date_closed: p.date_closed ?? null,
          line_items: { edges: p.lines.map(([sku, quantity, quantity_received]) => ({ node: { sku, quantity, quantity_received, quantity_rejected: 0, fulfillment_status: "pending" } })) },
        }))) } as T;
      }
      if (q.includes("warehouse_products(")) {
        return { warehouse_products: page((d.wps ?? []).map((w) => ({ ...w, warehouse_id: "WH1", updated_at: null, product: { name: w.name ?? null, sku: w.sku } }))) } as T;
      }
      if (q.includes("products(tag:")) return { products: page(d.tagged ?? []) } as T;
      throw new Error(`unexpected query ${q.slice(0, 40)}`);
    },
  };
  return client;
}

describe.skipIf(!hasTestDb)("ShipHero sync (DB)", () => {
  const db = hasTestDb ? testDb() : (null as never);
  afterAll(async () => db?.$disconnect());

  let po: { id: string };
  beforeEach(async () => {
    await resetDb(db);
    await db.shipheroAccount.createMany({ data: [
      { id: "mi", name: "Mainfactor Michigan", warehouseName: "Mainfactor Michigan", type: "direct", tokenRef: "SHIPHERO_TOKEN_MICHIGAN" },
      { id: "pa", name: "Mainfactor Philly", warehouseName: "Mainfactor Philly", type: "direct", tokenRef: "SHIPHERO_TOKEN_PHILLY" },
    ] });
    const st = await db.store.create({ data: { name: "Sleep Token", code: "SLE", skuPrefixes: ["STOK"], enabled: true, warehouseName: "Mainfactor Michigan" } });
    await db.store.create({ data: { name: "Bunnie Xo", code: "BUN", skuPrefixes: ["BUNN"], enabled: true, warehouseName: "Mainfactor Philly" } });
    await db.product.create({ data: { sku: "STOKNR104581OT", storeId: st.id } });
    po = await db.purchaseOrder.create({ data: {
      orderNo: "PO094330", kind: "PO", warehouseCode: "MAINF MI", storeId: st.id, stage: "issued", issuedAt: new Date("2026-11-10T00:00:00Z"),
      lines: { create: [
        { lineKey: "STOKNR104581OT", productSku: "STOKNR104581OT" }, // placeholder from the email
        { lineKey: "STOKNR104581OT_MD", productSku: "STOKNR104581OT", variantSku: "STOKNR104581OT_MD", qtyOrdered: 120 }, // from the PDF
      ] },
    } });
  });

  const run = (sh: ShipheroClient, which = ["mi"]) =>
    runShipheroSync({ db, now: () => NOW, clientFor: (a) => (which.includes(a.id) ? sh : null) });

  it("matches by suffix, fills ShipHero and received qty, and moves the stage", async () => {
    const sh = fakeShiphero({ pos: [
      { id: "SHPO1", po_number: "STOK - PO094330", lines: [["STOKNR104581OT_MD", 120, 0], ["STOKNR104581OT_LG", 80, 0]] },
      { id: "SHPO2", po_number: "STOK - PO0943301", lines: [["X", 1, 0]] }, // must not match
    ] });
    const stats = await run(sh);
    expect(stats.find((s) => s.account === "Mainfactor Philly")?.skipped).toMatch(/token not set/);
    expect(stats[0]).toMatchObject({ matched: 1, ambiguous: 0, storesMatched: 1, poPassComplete: true });

    let p = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: { orderBy: { lineKey: "asc" } } } });
    expect(p).toMatchObject({ stage: "in_shiphero", shipheroId: "SHPO1" });
    expect(p.lines.map((l) => [l.lineKey, l.qtyOrdered, l.qtyShiphero, l.qtyReceived])).toEqual([
      ["STOKNR104581OT_LG", null, 80, 0],
      ["STOKNR104581OT_MD", 120, 120, 0],
    ]); // placeholder line replaced
    expect((await db.store.findUniqueOrThrow({ where: { code: "SLE" } })).shipheroWarehouseId).toBe("WH1");

    // Partly received
    const sh2 = fakeShiphero({ pos: [{ id: "SHPO1", po_number: "STOK - PO094330", lines: [["STOKNR104581OT_MD", 120, 120], ["STOKNR104581OT_LG", 80, 0]] }] });
    await run(sh2);
    p = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: true } });
    expect(p.stage).toBe("receiving");
    expect(p.receivedAt).toBeNull();

    // Fully received
    const sh3 = fakeShiphero({ pos: [{ id: "SHPO1", po_number: "STOK - PO094330", date_closed: "2026-11-20T15:00:00Z", lines: [["STOKNR104581OT_MD", 120, 120], ["STOKNR104581OT_LG", 80, 80]] }] });
    await run(sh3);
    const done = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
    expect(done.stage).toBe("received");
    expect(done.receivedAt?.toISOString()).toBe("2026-11-20T15:00:00.000Z");
    const kinds = (await db.event.findMany({ where: { poId: po.id }, orderBy: { at: "asc" } })).map((e) => e.kind).sort();
    expect(kinds).toEqual(["sh_po_matched", "sh_received", "sh_receiving"]);
  });

  it("keeps an email 'shipped' stage when ShipHero hasn't received anything", async () => {
    await db.purchaseOrder.update({ where: { id: po.id }, data: { stage: "shipped" } });
    await run(fakeShiphero({ pos: [{ id: "SHPO1", po_number: "PO094330", lines: [["STOKNR104581OT_MD", 120, 0]] }] }));
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).stage).toBe("shipped");
  });

  it("raises an issue instead of guessing when two ShipHero POs match", async () => {
    const stats = await run(fakeShiphero({ pos: [
      { id: "A", po_number: "STOK - PO094330", lines: [] },
      { id: "B", po_number: "STOK REORDER - PO094330", lines: [] },
    ] }));
    expect(stats[0].ambiguous).toBe(1);
    expect(await db.issue.findUnique({ where: { fingerprint: `SH-PO-MULTI:${po.id}` } })).toMatchObject({ severity: "yellow" });
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).shipheroId).toBeNull();
  });

  it("matches a ShipHero PO synced before the email arrived (cached)", async () => {
    await db.purchaseOrder.delete({ where: { id: po.id } });
    await run(fakeShiphero({ pos: [{ id: "SHPO9", po_number: "STOK - PO099999", lines: [["STOKNR104581OT_MD", 10, 0]] }] }));
    const st = await db.store.findUniqueOrThrow({ where: { code: "SLE" } });
    const late = await db.purchaseOrder.create({ data: { orderNo: "PO099999", kind: "PO", warehouseCode: "MAINF MI", storeId: st.id, stage: "issued" } });
    await run(fakeShiphero({ pos: [] })); // nothing new from ShipHero
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: late.id } })).shipheroId).toBe("SHPO9");
  });

  it("syncs inventory and pre-order tags (case-insensitive), and clears removed tags", async () => {
    const sh = fakeShiphero({
      wps: [
        { sku: "STOKNR104581OT_MD", on_hand: 0, available: -12, allocated: 0, backorder: 12, name: "Tour Tee" },
        { sku: "STOKNR104581OT_LG", on_hand: 40, available: 40, allocated: 0, backorder: 0 },
        { sku: "ZZZZNR1_OS", on_hand: 5, available: 5, allocated: 0, backorder: 0 },
      ],
      tagged: [{ sku: "STOKNR104581OT_MD", tags: ["Pre-Order", "tour"] }],
    });
    const stats = await run(sh);
    expect(stats[0]).toMatchObject({ inventoryRows: 3, inventoryPassComplete: true, preorderSkus: 1 });
    expect(await db.variant.findUniqueOrThrow({ where: { sku: "STOKNR104581OT_MD" } })).toMatchObject({ inShiphero: true, onHand: 0, backorder: 12, preorder: true, preorderSource: "product_tag", tags: ["Pre-Order", "tour"] });
    expect(await db.variant.findUniqueOrThrow({ where: { sku: "STOKNR104581OT_LG" } })).toMatchObject({ onHand: 40, preorder: false });
    expect(await db.product.findUniqueOrThrow({ where: { sku: "ZZZZNR1" } })).toMatchObject({ storeId: null });
    expect(sh.queries.some((q) => q.includes('"pre-order","PRE-ORDER","Pre-Order"'))).toBe(true);

    await run(fakeShiphero({ tagged: [] }));
    expect(await db.variant.findUniqueOrThrow({ where: { sku: "STOKNR104581OT_MD" } })).toMatchObject({ preorder: false, preorderSource: null });
  });

  it("only re-reads what changed since the last full pass", async () => {
    const sh = fakeShiphero({});
    await run(sh);
    const sh2 = fakeShiphero({});
    await run(sh2);
    const since = new Date(NOW.getTime() - 3600000).toISOString();
    expect(sh2.queries.find((q) => q.includes("purchase_orders("))).toContain(`updated_from: "${since}"`);
    expect(sh2.queries.find((q) => q.includes("warehouse_products("))).toContain(`updated_from: "${since}"`); // per-warehouse cursor
    expect(sh.queries.find((q) => q.includes("warehouse_products("))).not.toContain("updated_from");
  });

  it("warns a week before a pasted access token expires, and clears when replaced", async () => {
    const sh = fakeShiphero({});
    sh.accessTokenExpiresAt = () => new Date(NOW.getTime() + 3 * 86400000);
    await run(sh);
    expect(await db.issue.findUnique({ where: { fingerprint: "SH-TOKEN:mi" } })).toMatchObject({ severity: "yellow", status: "open" });
    sh.accessTokenExpiresAt = () => new Date(NOW.getTime() - 1000);
    await run(sh);
    expect(await db.issue.findUnique({ where: { fingerprint: "SH-TOKEN:mi" } })).toMatchObject({ severity: "red" });
    sh.accessTokenExpiresAt = () => new Date(NOW.getTime() + 28 * 86400000);
    await run(sh);
    expect(await db.issue.findUnique({ where: { fingerprint: "SH-TOKEN:mi" } })).toMatchObject({ status: "resolved" });
  });

  it("matches each store to its own warehouse by profile and syncs inventory per warehouse", async () => {
    const st2 = await db.store.create({ data: { name: "Megadeth", code: "MEG", skuPrefixes: ["MEGA"], enabled: true, warehouseName: "Mainfactor Michigan" } });
    await db.store.create({ data: { name: "Flat Black", code: "FLA", enabled: true, warehouseName: "Mainfactor Michigan" } });
    const sh = fakeShiphero({ warehouses: [
      { id: "W-SLE", identifier: "Primary", profile: "Sleep Token", active: true },
      { id: "W-MEG", identifier: "Primary", profile: "Megadeth", active: true },
      { id: "W-X", identifier: "Primary", profile: "Someone Else", active: true },
    ] });
    const stats = await run(sh);
    expect(stats[0]).toMatchObject({ warehouses: 3, storesMatched: 2, storesUnmatched: ["Flat Black"] });
    expect((await db.store.findUniqueOrThrow({ where: { id: st2.id } })).shipheroWarehouseId).toBe("W-MEG");
    const fla = await db.store.findUniqueOrThrow({ where: { code: "FLA" } });
    expect(await db.issue.findUnique({ where: { fingerprint: `SH-PROFILE:${fla.id}` } })).toMatchObject({ severity: "yellow" });
    const wpQueries = sh.queries.filter((q) => q.includes("warehouse_products("));
    expect(wpQueries.some((q) => q.includes('"W-SLE"'))).toBe(true);
    expect(wpQueries.some((q) => q.includes('"W-MEG"'))).toBe(true);
    expect(wpQueries.some((q) => q.includes('"W-X"'))).toBe(false);

    // Setting the profile name fixes it on the next sync.
    await db.store.update({ where: { id: fla.id }, data: { shipheroProfile: "Someone Else" } });
    await run(sh);
    expect((await db.store.findUniqueOrThrow({ where: { id: fla.id } })).shipheroWarehouseId).toBe("W-X");
    expect(await db.issue.findUnique({ where: { fingerprint: `SH-PROFILE:${fla.id}` } })).toMatchObject({ status: "resolved" });
  });

  it("prefers the ShipHero PO in the store's own warehouse", async () => {
    const sh = fakeShiphero({
      warehouses: [{ id: "W-SLE", identifier: "Primary", profile: "Sleep Token", active: true }, { id: "W-OTHER", identifier: "Primary", profile: "Other", active: true }],
      pos: [],
    });
    await run(sh);
    await db.shipheroPo.createMany({ data: [
      { id: "A", accountId: "mi", poNumber: "OTHR - PO094330", warehouseId: "W-OTHER", lines: { items: [] }, syncedAt: NOW },
      { id: "B", accountId: "mi", poNumber: "STOK - PO094330", warehouseId: "W-SLE", lines: { items: [] }, syncedAt: NOW },
    ] });
    const stats = await run(sh);
    expect(stats[0].ambiguous).toBe(0);
    expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).shipheroId).toBe("B");
  });
});
