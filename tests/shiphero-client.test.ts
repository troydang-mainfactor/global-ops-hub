import { describe, expect, it } from "vitest";
import { createShipheroClient, throttleWaitMs, tokenInfo } from "@/lib/shiphero/client";
import { orderKey, tagVariants, trailingOrderNo, warehouseForStore } from "@/lib/shiphero/sync";

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
    const c = createShipheroClient({ token: "RT", fetch: f, sleep: async () => {} });
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
    const c = createShipheroClient({ token: "RT", fetch: f, sleep: async (ms) => void waits.push(ms) });
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
    expect(await createShipheroClient({ token: "RT", fetch: f }).query("{x}")).toEqual({ ok: 1 });
    const bad = fakeFetch([{ status: 403 }]);
    await expect(createShipheroClient({ token: "RT", fetch: bad.f }).query("{x}")).rejects.toThrow(/auth failed/);
  });

  it("surfaces non-throttle GraphQL errors", async () => {
    const { f } = fakeFetch([{ json: { access_token: "AT", expires_in: 100000 } }, { json: { errors: [{ message: "Cannot query field" }] } }]);
    await expect(createShipheroClient({ token: "RT", fetch: f }).query("{x}")).rejects.toThrow(/Cannot query field/);
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
    expect(trailingOrderNo("ICEN - TO0008099")).toBe("TO0008099");
  });
  it("builds tolerant order keys", () => {
    for (const t of ["STOK - PO094330", "PO 094330", "PO94330 STOK", "PO094330", "po#094330"]) expect(orderKey(t)).toBe("PO94330");
    expect(orderKey("STOK - PO0943301")).toBe("PO943301");
    expect(orderKey("XPO094330")).toBeNull();
    expect(orderKey("ICEN - TO0008099")).toBe("TO8099");
  });

  it("finds each store's warehouse by profile", () => {
    const whs = [
      { id: "1", identifier: "Primary", profile: "Megadeth", active: true },
      { id: "2", identifier: "Primary", profile: "Falling In Reverse", active: true },
      { id: "3", identifier: "Primary", profile: "BINI Official", active: true },
      { id: "4", identifier: "Primary", profile: "Old Store", active: false },
    ];
    const st = (name: string, code: string | null = null, shipheroProfile: string | null = null) => ({ name, code, shipheroProfile });
    expect(warehouseForStore(st("Megadeth", "MEG"), whs)?.id).toBe("1");
    expect(warehouseForStore(st("falling in reverse"), whs)?.id).toBe("2");
    expect(warehouseForStore(st("BINI", "BINI"), whs)?.id).toBe("3"); // loose: profile contains store name
    expect(warehouseForStore(st("Flat Black"), whs)).toBeNull();
    expect(warehouseForStore(st("Anything", null, "Megadeth"), whs)?.id).toBe("1"); // override
    expect(warehouseForStore(st("Megadeth", null, "Typo"), whs)).toBeNull(); // override must match exactly
    expect(warehouseForStore(st("Old Store"), whs)).toBeNull(); // inactive ignored
    expect(warehouseForStore(st("Whatever"), [{ id: "9", identifier: "Primary", profile: null, active: true }])?.id).toBe("9"); // single warehouse
  });
  it("sends case variants of pre-order tags", () => {
    expect(tagVariants(["pre-order"])).toEqual(["pre-order", "PRE-ORDER", "Pre-Order"]);
  });
});

const jwt = (exp: number) => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig`;

describe("pasted access tokens", () => {
  const future = Math.floor(Date.now() / 1000) + 10 * 86400;
  it("recognises access vs refresh tokens and reads expiry", () => {
    expect(tokenInfo(jwt(future))).toEqual({ kind: "access", expiresAt: new Date(future * 1000) });
    expect(tokenInfo(`Bearer ${jwt(future)}`).kind).toBe("access");
    expect(tokenInfo("v1.MRrefreshopaque").kind).toBe("refresh");
  });
  it("uses an access token directly, without calling /auth/refresh", async () => {
    const { f, calls } = fakeFetch([{ json: { data: { ok: 1 } } }]);
    const c = createShipheroClient({ token: jwt(future), fetch: f });
    expect(await c.query("{x}")).toEqual({ ok: 1 });
    expect(calls.map((x) => x.url)).toEqual(["https://public-api.shiphero.com/graphql"]);
    expect(calls[0].auth).toBe(`Bearer ${jwt(future)}`);
    expect(c.accessTokenExpiresAt?.()).toEqual(new Date(future * 1000));
  });
  it("fails clearly when the access token has expired or is rejected", async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    await expect(createShipheroClient({ token: jwt(past), fetch: fakeFetch([]).f }).query("{x}")).rejects.toThrow(/expired on/);
    await expect(createShipheroClient({ token: jwt(future), fetch: fakeFetch([{ status: 401 }]).f }).query("{x}")).rejects.toThrow(/rejected the access token/);
  });
});
