import { describe, expect, it } from "vitest";
import { createShipheroClient, throttleWaitMs } from "@/lib/shiphero/client";
import { pickWarehouse, tagVariants, trailingOrderNo } from "@/lib/shiphero/sync";

function fakeFetch(responses: Array<{ status?: number; json?: unknown }>) {
  const calls: { url: string; body: string; auth: string | null }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body), auth: (init.headers as Record<string, string>).Authorization ?? null });
    const r = responses.shift() ?? { status: 500 };
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("ShipHero client", () => {
  it("swaps the refresh token for an access token once, then queries", async () => {
    const { f, calls } = fakeFetch([
      { json: { access_token: "AT1", expires_in: 2419200 } },
      { json: { data: { ok: 1 } } },
      { json: { data: { ok: 2 } } },
    ]);
    const c = createShipheroClient({ refreshToken: "RT", fetch: f, sleep: async () => {} });
    expect(await c.query("{a}")).toEqual({ ok: 1 });
    expect(await c.query("{b}")).toEqual({ ok: 2 });
    expect(calls.map((x) => x.url)).toEqual([
      "https://public-api.shiphero.com/auth/refresh",
      "https://public-api.shiphero.com/graphql",
      "https://public-api.shiphero.com/graphql",
    ]);
    expect(JSON.parse(calls[0].body)).toEqual({ refresh_token: "RT" });
    expect(calls[1].auth).toBe("Bearer AT1");
  });

  it("waits and retries when out of credits", async () => {
    const waits: number[] = [];
    const { f } = fakeFetch([
      { json: { access_token: "AT", expires_in: 100000 } },
      { json: { errors: [{ code: 30, message: "There are not enough credits to perform the requested operation", time_remaining: "3 seconds" }] } },
      { json: { data: { ok: true } } },
    ]);
    const c = createShipheroClient({ refreshToken: "RT", fetch: f, sleep: async (ms) => void waits.push(ms) });
    expect(await c.query("{x}")).toEqual({ ok: true });
    expect(waits).toEqual([3500]);
  });

  it("refreshes again after a 401 and fails clearly on bad tokens", async () => {
    const { f } = fakeFetch([
      { json: { access_token: "OLD", expires_in: 100000 } },
      { status: 401 },
      { json: { access_token: "NEW", expires_in: 100000 } },
      { json: { data: { ok: 1 } } },
    ]);
    expect(await createShipheroClient({ refreshToken: "RT", fetch: f }).query("{x}")).toEqual({ ok: 1 });
    const bad = fakeFetch([{ status: 403 }]);
    await expect(createShipheroClient({ refreshToken: "RT", fetch: bad.f }).query("{x}")).rejects.toThrow(/auth failed/);
  });

  it("surfaces non-throttle GraphQL errors", async () => {
    const { f } = fakeFetch([{ json: { access_token: "AT", expires_in: 100000 } }, { json: { errors: [{ message: "Cannot query field" }] } }]);
    await expect(createShipheroClient({ refreshToken: "RT", fetch: f }).query("{x}")).rejects.toThrow(/Cannot query field/);
  });

  it("reads time_remaining", () => {
    expect(throttleWaitMs([{ code: 30, time_remaining: "12 seconds" }])).toBe(12500);
    expect(throttleWaitMs([{ message: "other" }])).toBeNull();
  });
});

describe("ShipHero helpers", () => {
  it("extracts the order number a ShipHero PO number ends with", () => {
    expect(trailingOrderNo("STOK - PO094330")).toBe("PO094330");
    expect(trailingOrderNo("PO094330")).toBe("PO094330");
    expect(trailingOrderNo("stok-so0058136 ")).toBe("SO0058136");
    expect(trailingOrderNo("STOK - PO094330A")).toBeNull();
    expect(trailingOrderNo("XPO094330")).toBeNull();
  });
  it("picks the account's warehouse", () => {
    expect(pickWarehouse([{ id: "1", identifier: "Primary", active: true }], "Mainfactor Michigan")?.id).toBe("1");
    const two = [{ id: "1", identifier: "Mainfactor Michigan", active: true }, { id: "2", identifier: "Returns", active: true }];
    expect(pickWarehouse(two, "mainfactor michigan")?.id).toBe("1");
    expect(pickWarehouse(two, "Philly")).toBeNull();
  });
  it("sends case variants of pre-order tags", () => {
    expect(tagVariants(["pre-order"])).toEqual(["pre-order", "PRE-ORDER", "Pre-Order"]);
  });
});
