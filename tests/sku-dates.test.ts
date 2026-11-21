import { describe, expect, it } from "vitest";
import { baseSku, normalizeSizeLabel, skuConventionProblems, storeCodeForSku, variantSku } from "@/lib/sku";
import { parseLooseDate, isoDate } from "@/lib/email/dates";

describe("sku", () => {
  it("rolls variants up to the base SKU", () => {
    expect(baseSku("FALRNR103455RD_MD")).toBe("FALRNR103455RD");
    expect(baseSku(" falrnr103455rd ")).toBe("FALRNR103455RD");
  });
  it("builds variant SKUs from PDF size labels", () => {
    expect(variantSku("FALRNR103455RD", "Medium")).toBe("FALRNR103455RD_MD");
    expect(variantSku("FALRNR103455RD", "XXL")).toBe("FALRNR103455RD_2XL");
    expect(variantSku("FALRNR103455RD", "One Size")).toBe("FALRNR103455RD_OS");
    expect(variantSku("FALRNR103455RD", "weird")).toBeNull();
    expect(normalizeSizeLabel("s")).toBe("SM");
  });
  it("picks the longest matching store code", () => {
    expect(storeCodeForSku("STOKNR104581OT", ["STO", "STOK", "FALR"])).toBe("STOK");
    expect(storeCodeForSku("ZZZZ1", ["STOK"])).toBeNull();
  });
  it("reports convention problems", () => {
    expect(skuConventionProblems("FALRNR103455RD_MD")).toEqual([]);
    expect(skuConventionProblems("FALRNR103455RD_OS")).toEqual([]);
    expect(skuConventionProblems("FALRNR103455RD_M").length).toBeGreaterThan(0);
    expect(skuConventionProblems("FALRNR103455RD-MD").length).toBeGreaterThan(0);
    expect(skuConventionProblems("falrnr103455rd").length).toBeGreaterThan(0);
  });
});

describe("dates", () => {
  const ref = new Date("2026-11-20T00:00:00Z");
  it.each([
    ["2026-12-02", "2026-12-02"],
    ["12/02/2026", "2026-12-02"],
    ["Dec 2, 2026", "2026-12-02"],
    ["December 2 2026", "2026-12-02"],
    ["2 Dec 2026", "2026-12-02"],
    ["Wed, Dec 2", "2026-12-02"],
    ["Dec 2", "2026-12-02"],
    ["Jan 5", "2027-01-05"], // year rolls forward near year end
    ["Sept 3, 2026", "2026-09-03"],
  ])("parses %s", (raw, iso) => {
    expect(isoDate(parseLooseDate(raw, ref))).toBe(iso);
  });
  it.each(["", "[no value]", "TBD", "N/A", "02/30/2026", "someday"])("returns null for %j", (raw) => {
    expect(parseLooseDate(raw, ref)).toBeNull();
  });
});
