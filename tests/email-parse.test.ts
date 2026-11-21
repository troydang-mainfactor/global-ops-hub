import { describe, expect, it } from "vitest";
import { classifySubject, forwardedOriginal, htmlToText, parseEmail, splitTracking } from "@/lib/email/parse";
import * as f from "./fixtures/emails";

function ok(input: { subject: string; body: string; receivedAt?: Date }) {
  const r = parseEmail(input);
  if (!r.ok) throw new Error(`expected parse to succeed: ${r.reason}`);
  return r.data;
}

describe("PO issued (New Order) emails", () => {
  it("parses a PO number to the Mainfactor warehouse", () => {
    const d = ok(f.issuedStok);
    expect(d).toMatchObject({
      kind: "issued",
      orderNo: "PO094330",
      orderKind: "PO",
      sku: "STOKNR104581OT",
      warehouseCode: "MAINF MI",
      designName: "Stokes Tour Tee 2026",
      orderType: "New",
      productionTaskUrl: f.ASANA_TASK_URL,
      missing: [],
    });
  });

  it("parses a second example", () => {
    expect(ok(f.issuedEvan)).toMatchObject({ orderNo: "PO094352", sku: "EVANRX103143BK", designName: "Evan Black Hoodie" });
  });

  it("parses an SO number to the UK warehouse", () => {
    expect(ok(f.issuedSoUk)).toMatchObject({ orderNo: "SO0058136", orderKind: "SO", warehouseCode: "BSI UK", sku: "STOKRX004233OT" });
  });

  it("tolerates spacing differences in the subject", () => {
    const d = ok({ ...f.issuedStok, subject: "New Order  STOKNR104581OT /PO094330 /  mainf  mi " });
    expect(d).toMatchObject({ sku: "STOKNR104581OT", orderNo: "PO094330", warehouseCode: "MAINF MI" });
  });

  it("flags missing body fields so the AI fallback can fill them", () => {
    const d = ok({ subject: f.issuedStok.subject, body: "SKU: STOKNR104581OT" });
    expect(d.missing).toEqual(expect.arrayContaining(["designName", "productionTaskUrl"]));
  });

  it("rolls a variant SKU in the subject up to its base SKU", () => {
    const d = ok({ ...f.issuedStok, subject: "New Order STOKNR104581OT_MD/ PO094330/ MAINF MI" });
    expect(d.sku).toBe("STOKNR104581OT");
    expect(d.skuRaw).toBe("STOKNR104581OT_MD");
  });
});

describe("Shipped from vendor emails", () => {
  it("parses tracking, delivery date, warehouse and design name", () => {
    const d = ok(f.shippedFalr);
    expect(d).toMatchObject({
      kind: "shipped",
      orderNo: "PO094108",
      sku: "FALRNR103455RD",
      warehouseCode: "MAINF MI",
      bodyWarehouseCode: "MAINF MI",
      designName: "Falr Red Logo Tee",
      tracking: ["1Z999AA10123456784", "1Z999AA10123456785"],
      deliveryDate: "2026-12-02",
      productionTaskUrl: f.ASANA_TASK_URL,
      missing: [],
    });
  });

  it("handles a component suffix in the subject and [no value] delivery date", () => {
    const d = ok(f.shippedMegaComponentNoDate);
    expect(d).toMatchObject({
      orderNo: "PO093125",
      sku: "MEGARX203613GR",
      componentLabel: "Hand Cuffs (Component)",
      deliveryDate: null,
      deliveryDateRaw: "[no value]",
      tracking: ["1Z999AA10123456799"],
      designName: "Mega Green Hand Cuffs",
    });
    expect(d.missing).not.toContain("deliveryDate");
  });

  it("handles Fwd: prefixes and CRLF line endings", () => {
    expect(ok(f.shippedForwardedCrlf)).toMatchObject({ orderNo: "PO094108", deliveryDate: "2026-12-02", designName: "Falr Red Logo Tee" });
  });

  it("keeps the body warehouse for cross-checking when it differs from the subject", () => {
    const d = ok(f.shippedWarehouseMismatch);
    expect(d.warehouseCode).toBe("MAINF MI");
    expect(d.bodyWarehouseCode).toBe("BSI UK");
    expect(d.deliveryDate).toBe("2026-12-05");
  });

  it("reads only the warehouse line, not the signature below it", () => {
    const d = ok(f.shippedWithSignature);
    expect(d.bodyWarehouseCode).toBe("MAINF MI");
    expect(d.warehouseCode).toBe("MAINF MI");
    expect(d.deliveryDate).toBeNull();
    expect(d.tracking).toEqual(["1Z999AA10123456722"]);
    expect(d.designName).toBe("Voices in My Head/Bad Guy");
  });

  it("flags missing tracking", () => {
    const d = ok({ ...f.shippedFalr, body: f.shippedFalr.body.replace(/1Z\S+/, "[no value]") });
    expect(d.tracking).toEqual([]);
    expect(d.missing).toContain("tracking");
  });
});

describe("unknown formats", () => {
  it("rejects messages that match neither format", () => {
    const r = parseEmail(f.unknownFormat);
    expect(r.ok).toBe(false);
    expect(classifySubject(f.unknownFormat.subject)).toBeNull();
  });

  it("rejects a shipped-looking subject whose body is not a shipped notice", () => {
    expect(parseEmail({ subject: "PO094108 /FALRNR103455RD / MAINF MI", body: "Quick question about this PO" }).ok).toBe(false);
  });
});

describe("helpers", () => {
  it("splits tracking numbers on slashes, commas and spaces and de-duplicates", () => {
    expect(splitTracking("1Z999AA10123456784/1Z999AA10123456785, 1z999aa10123456784")).toEqual([
      "1Z999AA10123456784",
      "1Z999AA10123456785",
    ]);
    expect(splitTracking("[no value]")).toEqual([]);
  });

  it("converts HTML-only bodies so the parser still works", () => {
    const html = f.shippedFalr.body
      .split("\n")
      .map((l) => `<div>${l.replace(/(https:\S+)/, '<a href="$1">$1</a>')}</div>`)
      .join("");
    expect(ok({ ...f.shippedFalr, body: htmlToText(html) })).toMatchObject({ deliveryDate: "2026-12-02", tracking: ["1Z999AA10123456784", "1Z999AA10123456785"] });
  });
});

describe("forwarded emails", () => {
  it("reads the original headers from a Gmail forward", () => {
    const h = forwardedOriginal(`hi\n\n---------- Forwarded message ---------\nFrom: Jonathan Stanley <j@x.com>\nDate: Mon, Nov 10, 2026 at 3:04 PM\nSubject: New Order A/ PO1/ MAINF MI\nTo: <in@x.com>\n\nbody`);
    expect(h?.subject).toBe("New Order A/ PO1/ MAINF MI");
    expect(h?.date?.getFullYear()).toBe(2026);
    expect(h?.date?.getMonth()).toBe(10);
    expect(h?.date?.getDate()).toBe(10);
  });
  it("reads an Outlook-style forward", () => {
    const h = forwardedOriginal(`From: Jonathan Stanley\r\nSent: Monday, November 10, 2026 3:04 PM\r\nTo: inbound\r\nSubject: PO094108 /FALRNR103455RD / MAINF MI\r\n\r\nbody`);
    expect(h?.subject).toBe("PO094108 /FALRNR103455RD / MAINF MI");
    expect(h?.date?.getDate()).toBe(10);
  });
  it("returns null when there is no forwarded block", () => {
    expect(forwardedOriginal(f.issuedStok.body)).toBeNull();
  });
});
