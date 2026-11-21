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
| Gmail | `GMAIL_MAILBOX` + `GMAIL_SA_KEY_JSON` **or** `GMAIL_OAUTH_*` | Scope `https://www.googleapis.com/auth/gmail.modify` (read + add labels) |
| Claude | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-opus-5-5`) | Without it: regex parsing only, PDFs wait in the queue |
| Cron | `CRON_SECRET` | Scheduler calls `GET /api/jobs/gmail-ingest` with `Authorization: Bearer $CRON_SECRET` |

### Gmail service account (recommended)

1. Google Cloud console → create a service account → create a JSON key.
2. Google Workspace Admin → Security → API controls → **Domain-wide delegation** → add the service account's client ID with scope `https://www.googleapis.com/auth/gmail.modify`.
3. Paste the JSON key (or its base64) into `GMAIL_SA_KEY_JSON`, set `GMAIL_MAILBOX=globalinboundupdates@mainfactor.com`.
4. Settings → Jobs → **Gmail backfill** (last 120 days), then let the 5-minute cron run **Gmail ingest**.

### Scheduling

`vercel.json` runs `gmail-ingest` every 5 minutes (needs a Vercel plan that allows that frequency). Anywhere else, call the endpoint from any cron:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/jobs/gmail-ingest
```

## How ingest works

`src/lib/ingest/gmail-ingest.ts`

1. Lists messages from the last N days (3 for the poll, 120 for backfill). Idempotent by Gmail message ID (`EmailMessage` table), so overlap is free.
2. Parses subject + body with regex (`src/lib/email/parse.ts`). If the format is unknown or fields are missing, Claude fills in (`src/lib/ai/parser.ts`); low confidence raises **R17**.
3. Matches the SKU to a store by prefix (Settings → Stores). Unknown or disabled store → message saved as `skipped`; it is applied automatically on the next run after the store is enabled (no Gmail re-fetch).
4. Upserts `PurchaseOrder` (by order number + warehouse), `PoLine`, `Product`, and a timeline `Event`. Stages only move forward. Email delivery date → ETA (`etaSource = email`).
5. Picks the PO PDF attachment and parses it with Claude into sized lines and quantities. PDF dates set the ETA only if no email date exists. Max 25 PDFs per run; 3 attempts, then an issue.
6. Labels the Gmail message `ops-hub/processed` (or `ops-hub/unknown-format`).

Issues raised in this step:

| Rule | When | Severity |
|---|---|---|
| `ING-WAREHOUSE` | Warehouse code not mapped to ShipHero (auto-resolves when you map it) | yellow |
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
