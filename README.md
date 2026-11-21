# Global Ops Hub

Tracks every product from **PO issued → shipped → received → launched**. Spec: [`SPEC.md`](SPEC.md). Reference material: [`reference/`](reference/).

**Built so far:** Phase 0 (foundation) and Phase 1 step 1 (Gmail ingest + PO PDF parsing).

## Quick start (local)

```bash
npm install
cp .env.example .env          # set DATABASE_URL at minimum
npx prisma migrate dev         # creates tables
npx prisma db seed             # Troy's stores (enabled) + known warehouse codes
AUTH_DEV_BYPASS=1 npm run dev  # local only: skips Google sign-in
```

Optional: `npm run demo` loads the sample emails from `tests/fixtures/emails.ts` through the real ingest code, so the screens have data.

## Tests

```bash
npm test        # parser + helper unit tests (no DB needed; DB tests are skipped)
npm run test:db # everything, incl. ingest tests against TEST_DATABASE_URL (default: local opshub_test)
```

## Configuration

All secrets live in env vars (see [`.env.example`](.env.example)). The DB only stores the **name** of a secret (e.g. a ShipHero account's `tokenRef = SHIPHERO_TOKEN_MAIN`).

| What | Env vars | Notes |
|---|---|---|
| Database | `DATABASE_URL` | Postgres |
| Sign-in | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `ALLOWED_EMAIL_DOMAIN` | Google OAuth client; only `@mainfactor.com` accounts get in |
| Gmail | `GMAIL_MAILBOX` + `GMAIL_OAUTH_*` **or** `GMAIL_SA_KEY_JSON` | Read-only (`gmail.readonly`). Only messages matching the Gmail search in Settings are read |
| Claude | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-opus-5-5`) | Without it: regex parsing only, PDFs wait in the queue |
| Cron | `CRON_SECRET` | Scheduler calls `GET /api/jobs/gmail-ingest` with `Authorization: Bearer $CRON_SECRET` |

### Gmail: forward the PO emails to your own mailbox

Use this until the app can read `globalinboundupdates@` directly.

1. **Get the emails into your mailbox.** Ask whoever owns `globalinboundupdates@` (or a Workspace admin) to auto-forward it to you, or add you to the group it sends to. Forwarded copies work: the app reads the original subject and send time from the forwarded header.
2. **Label them.** In your Gmail: Settings → Filters → Create filter. From: `globalinboundupdates@mainfactor.com OR globalmerchservices.com`. Choose **Apply the label** `ops-hub-inbound` and **Also apply filter to matching conversations**. The app only reads messages with this label (Settings → Thresholds → Gmail search).
3. **Give the app read-only access (OAuth):**
   1. Use the Google OAuth client from sign-in (or a separate one). Add redirect URI `https://developers.google.com/oauthplayground`.
   2. Open the [OAuth Playground](https://developers.google.com/oauthplayground). In the gear icon, tick **Use your own OAuth credentials** and enter the client ID and secret.
   3. Under Step 1, enter scope `https://www.googleapis.com/auth/gmail.readonly` → Authorize APIs → sign in as yourself.
   4. Step 2 → **Exchange authorization code for tokens**. Copy the refresh token into `GMAIL_OAUTH_REFRESH_TOKEN` on your host.
   5. Set `GMAIL_MAILBOX` to your address, plus `GMAIL_OAUTH_CLIENT_ID` and `GMAIL_OAUTH_CLIENT_SECRET`.
4. Settings → Jobs → **Gmail backfill**, then let the 5-minute cron run **Gmail ingest**.

Note: a Gmail token can technically read your whole mailbox. The app only ever searches with the label filter, and refuses to run if the filter is empty. Revoke access any time at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

Later, to read `globalinboundupdates@` directly: switch `GMAIL_MAILBOX` and the refresh token to that mailbox (OAuth as that account), or use a service account with domain-wide delegation (scope `gmail.readonly`). Note that a service account can read every mailbox in the domain.

### ShipHero tokens (one per warehouse login)

Each store uses the ShipHero account for its warehouse (Settings → ShipHero accounts). Start with Michigan; Philly works the same way.

1. Sign in to the **Michigan** ShipHero login. Open [app.shiphero.com/dashboard/users](https://app.shiphero.com/dashboard/users) → **+Add Third-Party Developer**. Once added, ShipHero shows a **Bearer Token** and a **Refresh Token**.
2. Copy the **Refresh Token** into `SHIPHERO_TOKEN_MICHIGAN` on your host. The app swaps it for a short-lived access token itself (access tokens last 28 days).
3. Settings → ShipHero accounts should show **token set** for Mainfactor Michigan.

Alternative from ShipHero's docs: `POST https://public-api.shiphero.com/auth/token` with a dedicated API user's email and password returns a `refresh_token`. If MFA is on, ShipHero asks for an extra one-time-code step. Source: [developer.shiphero.com/getting-started](https://developer.shiphero.com/getting-started/).

### Scheduling

`vercel.json` runs `gmail-ingest` every 5 minutes (needs a Vercel plan that allows that frequency). Anywhere else, call the endpoint from any cron:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/jobs/gmail-ingest
```

## How ingest works

`src/lib/ingest/gmail-ingest.ts`

1. Lists messages matching the Gmail search in Settings (default `label:ops-hub-inbound`) from the last N days (3 for the poll, 120 for backfill). Idempotent by Gmail message ID (`EmailMessage` table), so overlap is free.
2. Parses subject + body with regex (`src/lib/email/parse.ts`). If the format is unknown or fields are missing, Claude fills in (`src/lib/ai/parser.ts`); low confidence raises **R17**.
3. Matches the SKU to a store by prefix (Settings → Stores). Matching uses Global's SKU prefix, which can differ from our store code. Each store's warehouse (Mainfactor Michigan / Philly) decides where its POs are matched in ShipHero; the email's warehouse code (`MAINF MI`, `MAINF PA`, `BSI UK`) is checked against it. Unknown or disabled store → message saved as `skipped`; it is applied automatically on the next run after the store is enabled (no Gmail re-fetch).
4. Upserts `PurchaseOrder` (by order number + warehouse), `PoLine`, `Product`, and a timeline `Event`. Stages only move forward. Email delivery date → ETA (`etaSource = email`).
5. Picks the PO PDF attachment and parses it with Claude into sized lines and quantities. PDF dates set the ETA only if no email date exists. Max 25 PDFs per run; 3 attempts, then an issue.
6. If `GMAIL_APPLY_LABELS=1`, labels the Gmail message `ops-hub/processed` (or `ops-hub/unknown-format`). Off by default so access stays read-only.

Issues raised in this step:

| Rule | When | Severity |
|---|---|---|
| `ING-STORE-WAREHOUSE` | Store has no warehouse set (auto-resolves when you set it) | yellow |
| `ING-STORE-WH` | PO goes to a different warehouse than the store's usual one | info |
| `ING-WAREHOUSE` | New warehouse code seen in the emails | info |
| `ING-WH-MISMATCH` | Shipped email subject and body name different warehouses | yellow |
| `ING-FORMAT` | Email matches neither format (message kept) | info |
| `ING-PDF` | PO PDF failed 3 times | info |
| `R17` | Email or PDF read by AI with low confidence | info |

Prompts are versioned in `src/prompts/`; the version is stored with each result.

## Layout

```
prisma/schema.prisma        data model (SPEC §5 + small additions, marked "added")
prisma/seed-data.json       Troy's stores + warehouse codes for the seed
src/lib/email/              regex parser + date parsing (pure, unit-tested)
src/lib/gmail/              Gmail REST client
src/lib/ai/, src/prompts/   Claude calls (structured JSON output)
src/lib/ingest/             Gmail ingest service
src/lib/jobs/registry.ts    jobs + SyncRun logging
src/app/(app)/              screens: Today, Inbound, Products, Launches, Settings
tests/                      Vitest; fixtures in tests/fixtures/emails.ts
```
