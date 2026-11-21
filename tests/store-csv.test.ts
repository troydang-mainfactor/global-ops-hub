import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseStoreCsv } from "@/lib/store-csv";
import { importStoreRows } from "@/lib/store-import";
import { hasTestDb, resetDb, testDb } from "./helpers/db";

const SHEET = [
  "Store\tStore Code\tMF Store Manager\tGlobal Store Manager\tTier\tWarehouse",
  "5 Seconds of Summer Tour Store (CLOSED)\t\tBailey\tGabrielle\tA\tMainfactor Michigan",
  "[Ashton Irwin](https://admin.shopify.com/store/ashton-irwin)\tAST\tBailey\tGabrielle\tB\tMainfactor Michigan",
  "Falling In Reverse\tFNR\tTroy\tMaria\tA\tMainfactor Michigan",
  "Aventura (CLOSED)\tAVE\tTroy\tPatrick\tB\tMainfactor Michigan",
  "Skrillex again..\t\tJared\tPatrick\tB\tMainfactor Michigan",
].join("\n");

describe("parseStoreCsv", () => {
  it("reads the store managers sheet by header", () => {
    const rows = parseStoreCsv(SHEET);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ name: "5 Seconds of Summer Tour Store", code: null, closed: true, tier: "A" });
    expect(rows[1]).toMatchObject({ name: "Ashton Irwin", code: "AST", shopifyAdminUrl: "https://admin.shopify.com/store/ashton-irwin", manager: "Bailey", globalManager: "Gabrielle", warehouseName: "Mainfactor Michigan", skuPrefixes: null });
    expect(rows[4]).toMatchObject({ name: "Skrillex again..", code: null, closed: false });
  });

  it("reads an optional Global SKU prefix column", () => {
    const rows = parseStoreCsv("Store,Store Code,MF Store Manager,Global SKU Prefix\nFalling In Reverse,FNR,Troy,FALR\nMegadeth,MEG,Troy,\"MEGA, MEGX\"");
    expect(rows.map((r) => r.skuPrefixes)).toEqual([["FALR"], ["MEGA", "MEGX"]]);
  });

  it("still accepts the old headerless store,code,manager format", () => {
    expect(parseStoreCsv("Mega,MEGA,Troy\nNo code,,x")).toMatchObject([{ name: "Mega", code: "MEGA", manager: "Troy" }, { name: "No code", code: null }]);
  });
});

describe.skipIf(!hasTestDb)("importStoreRows (DB)", () => {
  const db = hasTestDb ? testDb() : (null as never);
  afterAll(async () => db?.$disconnect());
  beforeEach(async () => resetDb(db));

  it("links first-name managers, enables the chosen manager's open stores, keeps edits on re-import", async () => {
    const troy = await db.user.create({ data: { name: "Troy Dang", email: "troy@example.com" } });
    await importStoreRows(db, parseStoreCsv(SHEET), { enableManager: "Troy" });
    const fnr = await db.store.findUniqueOrThrow({ where: { code: "FNR" } });
    expect(fnr).toMatchObject({ managerId: troy.id, enabled: true, closed: false });
    expect(await db.store.findUniqueOrThrow({ where: { code: "AVE" } })).toMatchObject({ enabled: false, closed: true });
    expect(await db.store.findUniqueOrThrow({ where: { code: "AST" } })).toMatchObject({ enabled: false });
    expect(await db.store.count()).toBe(5);

    await db.store.update({ where: { id: fnr.id }, data: { skuPrefixes: ["FALR"], shipheroWarehouseId: "W1" } });
    await importStoreRows(db, parseStoreCsv(SHEET));
    expect(await db.store.findUniqueOrThrow({ where: { id: fnr.id } })).toMatchObject({ skuPrefixes: ["FALR"], shipheroWarehouseId: "W1", enabled: true });
    expect(await db.store.count()).toBe(5);
    expect(await db.user.count({ where: { name: { startsWith: "Troy" } } })).toBe(1);
  });
});
