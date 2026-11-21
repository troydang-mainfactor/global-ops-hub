import { describe, expect, it } from "vitest";
import { accountForStore } from "@/lib/shiphero/accounts";

const accounts = [
  { id: "mi", warehouseName: "Mainfactor Michigan" },
  { id: "pa", warehouseName: "Mainfactor Philly" },
];

describe("accountForStore", () => {
  it("uses the account for the store's warehouse", () => {
    expect(accountForStore({ shipheroAccountId: null, warehouseName: "Mainfactor Michigan" }, accounts)?.id).toBe("mi");
    expect(accountForStore({ shipheroAccountId: null, warehouseName: " mainfactor philly " }, accounts)?.id).toBe("pa");
  });
  it("honours an explicit override", () => {
    expect(accountForStore({ shipheroAccountId: "pa", warehouseName: "Mainfactor Michigan" }, accounts)?.id).toBe("pa");
  });
  it("returns null without a matching account", () => {
    expect(accountForStore({ shipheroAccountId: null, warehouseName: "BSI UK" }, accounts)).toBeNull();
    expect(accountForStore({ shipheroAccountId: null, warehouseName: null }, accounts)).toBeNull();
  });
});
