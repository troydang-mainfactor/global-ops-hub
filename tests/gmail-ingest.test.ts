import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runGmailIngest, pickPoPdf, LABEL_PROCESSED, LABEL_UNKNOWN } from "@/lib/ingest/gmail-ingest";
import { hasTestDb, resetDb, testDb } from "./helpers/db";
import { fakeAi, fakeGmail, msg } from "./helpers/fakes";
import * as f from "./fixtures/emails";

const NOW = new Date("2026-11-21T12:00:00Z");
const pdfAtt = (orderNo: string) => [
  { attachmentId: `att-${orderNo}`, filename: `Purchase Order ${orderNo}.pdf`, mimeType: "application/pdf", size: 1000 },
  { attachmentId: `img-${orderNo}`, filename: "mockup.png", mimeType: "image/png", size: 500 },
];

describe.skipIf(!hasTestDb)("Gmail ingest (DB)", () => {
  const db = hasTestDb ? testDb() : (null as never);
  afterAll(async () => db?.$disconnect());

  beforeEach(async () => {
    await resetDb(db);
    await db.store.createMany({
      data: [
        { name: "Stokes", code: "STOK", enabled: true },
        { name: "Falr", code: "FALR", enabled: true },
        { name: "Mega", code: "MEGA", enabled: true },
        { name: "Evan", code: "EVAN", enabled: false },
      ],
    });
    await db.warehouse.create({ data: { emailCode: "MAINF MI", shipheroWarehouseId: "V2FyZWhvdXNlOjE=" } });
  });

  it("creates POs, lines, products and timeline events from both formats", async () => {
    const gmail = fakeGmail([msg("m1", f.issuedStok, pdfAtt("PO094330")), msg("m2", f.shippedFalr), msg("m3", f.shippedMegaComponentNoDate)]);
    const stats = await runGmailIngest({ db, gmail, ai: null, now: () => NOW }, { mode: "backfill" });

    expect(stats).toMatchObject({ listed: 3, processed: 3, errors: 0, unknownFormat: 0, pdfPending: 1 });

    const stok = await db.purchaseOrder.findUniqueOrThrow({ where: { orderNo_warehouseCode: { orderNo: "PO094330", warehouseCode: "MAINF MI" } }, include: { lines: true } });
    expect(stok).toMatchObject({ stage: "issued", kind: "PO", productionTaskUrl: f.ASANA_TASK_URL, issuedAt: f.issuedStok.receivedAt });
    expect(stok.lines.map((l) => l.productSku)).toEqual(["STOKNR104581OT"]);
    expect(stok.pdfSource).toMatchObject({ messageId: "m1", attachmentId: "att-PO094330" });

    const falr = await db.purchaseOrder.findFirstOrThrow({ where: { orderNo: "PO094108" } });
    expect(falr).toMatchObject({ stage: "shipped", etaSource: "email", tracking: ["1Z999AA10123456784", "1Z999AA10123456785"] });
    expect(falr.etaAt?.toISOString()).toBe("2026-12-02T00:00:00.000Z");

    const mega = await db.purchaseOrder.findFirstOrThrow({ where: { orderNo: "PO093125" } });
    expect(mega).toMatchObject({ stage: "shipped", etaAt: null, deliveryDate: null });

    expect(await db.product.findUnique({ where: { sku: "FALRNR103455RD" } })).toMatchObject({ name: "Falr Red Logo Tee" });
    const events = await db.event.findMany({ orderBy: { at: "asc" } });
    expect(events.map((e) => e.kind)).toEqual(["email_issued", "email_shipped", "email_shipped"]);
    expect(events[0].sourceUrl).toContain("t-m1");
    expect(gmail.labels.m1).toEqual([LABEL_PROCESSED]);
  });

  it("is idempotent: a second run fetches nothing and duplicates nothing", async () => {
    const gmail = fakeGmail([msg("m1", f.issuedStok), msg("m2", f.shippedFalr)]);
    await runGmailIngest({ db, gmail, ai: null, now: () => NOW }, { mode: "backfill" });
    const fetchesAfterFirst = gmail.fetches;
    const stats = await runGmailIngest({ db, gmail, ai: null, now: () => NOW }, { mode: "incremental" });
    expect(stats).toMatchObject({ alreadySeen: 2, fetched: 0, processed: 0 });
    expect(gmail.fetches).toBe(fetchesAfterFirst);
    expect(await db.event.count()).toBe(2);
    expect(await db.purchaseOrder.count()).toBe(2);
  });

  it("moves a PO forward from issued to shipped and never backwards", async () => {
    const issued = { ...f.issuedStok, subject: "New Order FALRNR103455RD/ PO094108/ MAINF MI", body: f.issuedStok.body.replace(/STOKNR104581OT/g, "FALRNR103455RD"), receivedAt: new Date("2026-11-01T00:00:00Z") };
    // Shipped arrives first in the list, issued is older: stage must end as shipped.
    const gmail = fakeGmail([msg("a", issued), msg("b", f.shippedFalr)]);
    await runGmailIngest({ db, gmail, ai: null, now: () => NOW }, { mode: "backfill" });
    const po = await db.purchaseOrder.findFirstOrThrow({ where: { orderNo: "PO094108" } });
    expect(po).toMatchObject({ stage: "shipped", issuedAt: issued.receivedAt, shippedAt: f.shippedFalr.receivedAt });

    // A late re-sent "issued" email must not move it back.
    gmail.messages.push(msg("c", { ...issued, receivedAt: new Date("2026-11-20T00:00:00Z") }));
    await runGmailIngest({ db, gmail, ai: null, now: () => NOW }, { mode: "incremental" });
    expect((await db.purchaseOrder.findFirstOrThrow({ where: { orderNo: "PO094108" } })).stage).toBe("shipped");
  });

  it("treats one PO number in two warehouses as two POs", async () => {
    const uk = { ...f.issuedStok, subject: "New Order STOKNR104581OT/ PO094330/ BSI UK" };
    await runGmailIngest({ db, gmail: fakeGmail([msg("m1", f.issuedStok), msg("m2", uk)]), ai: null, now: () => NOW }, { mode: "backfill" });
    expect(await db.purchaseOrder.count({ where: { orderNo: "PO094330" } })).toBe(2);
  });

  it("skips disabled stores, then applies them once the store is switched on", async () => {
    const gmail = fakeGmail([msg("m1", f.issuedEvan)]);
    const s1 = await runGmailIngest({ db, gmail, ai: null, now: () => NOW }, { mode: "backfill" });
    expect(s1).toMatchObject({ skippedStoreDisabled: 1, processed: 0 });
    expect(await db.purchaseOrder.count()).toBe(0);

    await db.store.update({ where: { code: "EVAN" }, data: { enabled: true } });
    const s2 = await runGmailIngest({ db, gmail, ai: null, now: () => NOW }, { mode: "incremental" });
    expect(s2).toMatchObject({ reapplied: 1, fetched: 0 });
    expect(await db.purchaseOrder.findFirst({ where: { orderNo: "PO094352" } })).toMatchObject({ stage: "issued" });
    expect((await db.emailMessage.findUniqueOrThrow({ where: { id: "m1" } })).status).toBe("processed");
  });

  it("skips SKUs whose prefix is not in the store registry", async () => {
    const other = { ...f.issuedStok, subject: "New Order ZZZZNR100001BK/ PO090001/ MAINF MI" };
    const stats = await runGmailIngest({ db, gmail: fakeGmail([msg("m1", other)]), ai: null, now: () => NOW }, { mode: "backfill" });
    expect(stats.skippedUnknownStore).toBe(1);
    expect(await db.emailMessage.findUnique({ where: { id: "m1" } })).toMatchObject({ status: "skipped", skipReason: "unknown_store", baseSku: "ZZZZNR100001BK" });
  });

  it("raises an issue for unknown or unmapped warehouse codes", async () => {
    await runGmailIngest({ db, gmail: fakeGmail([msg("m1", f.issuedSoUk)]), ai: null, now: () => NOW }, { mode: "backfill" });
    const issue = await db.issue.findUniqueOrThrow({ where: { fingerprint: "ING-WAREHOUSE:BSI UK" } });
    expect(issue).toMatchObject({ severity: "yellow", status: "open" });
    expect(await db.warehouse.findUnique({ where: { emailCode: "BSI UK" } })).not.toBeNull();
    expect(await db.issue.findUnique({ where: { fingerprint: "ING-WAREHOUSE:MAINF MI" } })).toBeNull(); // mapped
  });

  it("flags a subject/body warehouse mismatch", async () => {
    await runGmailIngest({ db, gmail: fakeGmail([msg("m1", f.shippedWarehouseMismatch)]), ai: null, now: () => NOW }, { mode: "backfill" });
    expect(await db.issue.findUnique({ where: { fingerprint: "ING-WH-MISMATCH:m1" } })).toMatchObject({ severity: "yellow" });
  });

  it("keeps unknown formats and raises an info issue", async () => {
    const gmail = fakeGmail([msg("m1", f.unknownFormat)]);
    const stats = await runGmailIngest({ db, gmail, ai: null, now: () => NOW }, { mode: "backfill" });
    expect(stats.unknownFormat).toBe(1);
    expect(await db.emailMessage.findUnique({ where: { id: "m1" } })).toMatchObject({ status: "unknown_format" });
    expect(await db.issue.findUnique({ where: { fingerprint: "ING-FORMAT:m1" } })).toMatchObject({ severity: "info", ruleId: "ING-FORMAT" });
    expect(gmail.labels.m1).toEqual([LABEL_UNKNOWN]);
  });

  it("uses the AI fallback for unknown formats and raises R17 on low confidence", async () => {
    const ai = fakeAi({
      email: () => ({
        kind: "shipped", order_no: "PO094555", sku: "STOKNR104599BK", warehouse: "mainf mi", design_name: "Stokes Tee",
        tracking: ["1Z999AA10123456711"], delivery_date: "2026-12-09", production_task_url: null, confidence: 0.6,
      }),
    });
    const odd = { subject: "Shipment notice: PO094555 STOKNR104599BK", body: "Shipped today via UPS 1Z999AA10123456711, due Dec 9 at MAINF MI", receivedAt: new Date("2026-11-20T00:00:00Z") };
    const stats = await runGmailIngest({ db, gmail: fakeGmail([msg("m1", odd)]), ai, now: () => NOW }, { mode: "backfill" });
    expect(stats).toMatchObject({ aiFallbacks: 1, processed: 1 });
    const po = await db.purchaseOrder.findFirstOrThrow({ where: { orderNo: "PO094555" } });
    expect(po).toMatchObject({ stage: "shipped", warehouseCode: "MAINF MI", etaSource: "email" });
    expect(await db.emailMessage.findUnique({ where: { id: "m1" } })).toMatchObject({ parsedBy: "ai", confidence: 0.6 });
    expect(await db.issue.findUnique({ where: { fingerprint: "R17:email:m1" } })).toMatchObject({ ruleId: "R17", severity: "info" });
  });

  it("does not call the AI when the regex reads everything", async () => {
    const ai = fakeAi({ pdf: () => ({ po_number: null, vendor: null, order_date: null, ex_factory_date: null, ship_date: null, delivery_date: null, lines: [], confidence: 0.95, notes: null }) });
    await runGmailIngest({ db, gmail: fakeGmail([msg("m1", f.issuedStok), msg("m2", f.shippedFalr)]), ai, now: () => NOW }, { mode: "backfill" });
    expect(ai.calls.email).toBe(0);
  });

  it("parses the PO PDF into sized lines, sets the PDF ETA and replaces the placeholder line", async () => {
    const ai = fakeAi({
      pdf: () => ({
        po_number: "PO094330", vendor: "Acme Print", order_date: "2026-11-10", ex_factory_date: "2026-11-28", ship_date: null, delivery_date: "2026-12-08",
        lines: [
          { sku: "STOKNR104581OT", size: "S", description: "Tee", qty: 50, unit_cost: 4.1 },
          { sku: "STOKNR104581OT", size: "M", description: "Tee", qty: 120, unit_cost: 4.1 },
          { sku: "STOKNR104581OT_LG", size: null, description: "Tee", qty: 90, unit_cost: 4.1 },
          { sku: "STOKNR104581OT", size: "XL", description: "Tee", qty: 0, unit_cost: 4.1 },
        ],
        confidence: 0.93, notes: null,
      }),
    });
    const gmail = fakeGmail([msg("m1", f.issuedStok, pdfAtt("PO094330"))], { "att-PO094330": Buffer.from("%PDF-1.4 fake") });
    const stats = await runGmailIngest({ db, gmail, ai, now: () => NOW }, { mode: "backfill" });
    expect(stats).toMatchObject({ pdfParsed: 1, pdfFailed: 0, pdfPending: 0 });

    const po = await db.purchaseOrder.findFirstOrThrow({ where: { orderNo: "PO094330" }, include: { lines: { orderBy: { lineKey: "asc" } } } });
    expect(po.lines.map((l) => [l.lineKey, l.qtyOrdered])).toEqual([
      ["STOKNR104581OT_LG", 90],
      ["STOKNR104581OT_MD", 120],
      ["STOKNR104581OT_SM", 50],
    ]);
    expect(po).toMatchObject({ etaSource: "pdf" });
    expect(po.etaAt?.toISOString().slice(0, 10)).toBe("2026-12-08");
    expect(await db.variant.count({ where: { productSku: "STOKNR104581OT" } })).toBe(3);
    expect(await db.issue.count({ where: { ruleId: "R17" } })).toBe(0);

    // Running again does not re-parse the PDF.
    await runGmailIngest({ db, gmail, ai, now: () => NOW }, { mode: "incremental" });
    expect(ai.calls.pdf).toBe(1);
  });

  it("an email delivery date beats the PDF date", async () => {
    const ai = fakeAi({ pdf: () => ({ po_number: null, vendor: null, order_date: null, ex_factory_date: null, ship_date: "2026-11-25", delivery_date: null, lines: [{ sku: null, size: "OS", description: "x", qty: 10, unit_cost: null }], confidence: 0.9, notes: null }) });
    const issued = { ...f.issuedStok, subject: "New Order FALRNR103455RD/ PO094108/ MAINF MI", body: f.issuedStok.body.replace(/STOKNR104581OT/g, "FALRNR103455RD"), receivedAt: new Date("2026-11-01T00:00:00Z") };
    const gmail = fakeGmail([msg("a", issued, pdfAtt("PO094108")), msg("b", f.shippedFalr)], { "att-PO094108": Buffer.from("pdf") });
    await runGmailIngest({ db, gmail, ai, now: () => NOW }, { mode: "backfill" });
    const po = await db.purchaseOrder.findFirstOrThrow({ where: { orderNo: "PO094108" }, include: { lines: true } });
    expect(po.etaSource).toBe("email");
    expect(po.etaAt?.toISOString().slice(0, 10)).toBe("2026-12-02");
    expect(po.lines.map((l) => l.lineKey)).toEqual(["FALRNR103455RD_OS"]); // SKU-less line mapped to the PO's only SKU
  });

  it("retries a failing PDF, then raises an issue after 3 attempts", async () => {
    const ai = fakeAi(); // pdf fake throws
    const gmail = fakeGmail([msg("m1", f.issuedStok, pdfAtt("PO094330"))], { "att-PO094330": Buffer.from("pdf") });
    for (let i = 0; i < 4; i++) await runGmailIngest({ db, gmail, ai, now: () => NOW }, { mode: "incremental" });
    expect(ai.calls.pdf).toBe(3);
    expect(await db.issue.findFirst({ where: { ruleId: "ING-PDF" } })).not.toBeNull();
  });

  it("does not reopen dismissed issues", async () => {
    const gmail = fakeGmail([msg("m1", f.issuedSoUk)]);
    await runGmailIngest({ db, gmail, ai: null, now: () => NOW }, { mode: "backfill" });
    await db.issue.update({ where: { fingerprint: "ING-WAREHOUSE:BSI UK" }, data: { status: "dismissed", resolution: "UK warehouse handled outside ShipHero" } });
    gmail.messages.push(msg("m2", { ...f.issuedSoUk, subject: "New Order STOKRX004234OT/ SO0058137/ BSI UK" }));
    await runGmailIngest({ db, gmail, ai: null, now: () => NOW }, { mode: "incremental" });
    expect((await db.issue.findUniqueOrThrow({ where: { fingerprint: "ING-WAREHOUSE:BSI UK" } })).status).toBe("dismissed");
  });
});

describe("pickPoPdf", () => {
  const a = (filename: string, mimeType = "application/pdf") => ({ attachmentId: filename, filename, mimeType, size: 1 });
  it("prefers the Purchase Order PDF with the order number", () => {
    expect(pickPoPdf([a("Packing List.pdf"), a("Purchase Order PO094330.pdf")], { orderNo: "PO094330", kind: "shipped" })?.filename).toBe("Purchase Order PO094330.pdf");
  });
  it("does not guess on shipped emails with only a packing list", () => {
    expect(pickPoPdf([a("Packing List.pdf")], { orderNo: "PO094330", kind: "shipped" })).toBeNull();
  });
  it("takes a lone PDF on an issued email", () => {
    expect(pickPoPdf([a("scan.pdf"), a("img.png", "image/png")], { orderNo: "PO094330", kind: "issued" })?.filename).toBe("scan.pdf");
  });
});
