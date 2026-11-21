// ShipHero public GraphQL client: refresh-token auth + credit throttling.
// Docs: https://developer.shiphero.com/getting-started/
//  - POST /auth/refresh {refresh_token} → {access_token, expires_in} (access tokens last 28 days)
//  - Out of credits: error code 30 with time_remaining ("3 seconds"); wait, never retry in parallel.
//  - HTTP 429: request-rate limit (7,000 requests / 5 min).

const BASE = "https://public-api.shiphero.com";

export interface ShipheroClient {
  /** Runs a GraphQL query and returns `data` (the root object). Retries on credit throttling. */
  query<T = Record<string, unknown>>(gql: string): Promise<T>;
}

export class ShipheroError extends Error {}

export interface ClientOptions {
  refreshToken: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

/** Seconds to wait from a throttling error, anywhere in the error object ("3 seconds", 3, "0:00:03"). */
export function throttleWaitMs(err: unknown): number | null {
  const s = JSON.stringify(err ?? {});
  if (!/not enough credits|"code":\s*30\b/i.test(s)) return null;
  const m = s.match(/"time_remaining":\s*"?(\d+(?:\.\d+)?)\s*(second|sec|s)?/i);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) + 500 : 5000;
}

export function createShipheroClient(opts: ClientOptions): ShipheroClient {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = opts.maxRetries ?? 8;
  let access: { token: string; expiresAt: number } | null = null;

  async function token(): Promise<string> {
    if (access && access.expiresAt > Date.now() + 60_000) return access.token;
    const res = await doFetch(`${BASE}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: opts.refreshToken }),
    });
    if (!res.ok) throw new ShipheroError(`ShipHero auth failed (HTTP ${res.status}). Check the refresh token.`);
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new ShipheroError("ShipHero auth returned no access_token");
    access = { token: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return access.token;
  }

  return {
    async query<T>(gql: string): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        const res = await doFetch(`${BASE}/graphql`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${await token()}` },
          body: JSON.stringify({ query: gql }),
        });
        if (res.status === 401 && attempt === 0) {
          access = null; // token expired early: refresh once
          continue;
        }
        if (res.status === 429) {
          if (attempt >= maxRetries) throw new ShipheroError("ShipHero rate limit (HTTP 429) kept failing");
          await sleep(Number(res.headers.get("retry-after") ?? 10) * 1000);
          continue;
        }
        if (!res.ok) throw new ShipheroError(`ShipHero HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const body = (await res.json()) as { data?: T; errors?: unknown[] };
        if (body.errors?.length) {
          const wait = throttleWaitMs(body.errors);
          if (wait !== null && attempt < maxRetries) {
            await sleep(wait);
            continue;
          }
          throw new ShipheroError(`ShipHero error: ${JSON.stringify(body.errors).slice(0, 500)}`);
        }
        if (!body.data) throw new ShipheroError("ShipHero returned no data");
        return body.data;
      }
    },
  };
}
