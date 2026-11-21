import { describe, expect, it } from "vitest";
import { parseStoreCsv } from "@/lib/store-csv";

describe("parseStoreCsv", () => {
  it("reads header, quotes and tabs; skips bad rows", () => {
    const rows = parseStoreCsv(`store,store_code,manager
"Stokes, Official",stok,Troy Dang
Falr Store\tFALR\tTroy Dang
No code,,Someone
Mega,MEGA,`);
    expect(rows).toEqual([
      { name: "Stokes, Official", code: "STOK", manager: "Troy Dang" },
      { name: "Falr Store", code: "FALR", manager: "Troy Dang" },
      { name: "Mega", code: "MEGA", manager: null },
    ]);
  });
});
