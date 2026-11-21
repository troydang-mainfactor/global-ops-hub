# Global Ops Hub: Build Spec (v2)

A standalone internal app that tracks every product from **PO issued → shipped → received → launched**, cross-checks it against ShipHero and the Asana launch cards, and flags anything that doesn't line up.

Start with **Troy's stores**. Then roll out to the full client list by switching stores on in the registry. No code changes needed.

Hand this folder to Claude Code. Read `reference/` first.

---

## 1. The problem this solves

1. **I don't know when things get received**, so I don't know when products are ready to launch or to come off pre-order.
2. **I can't see if launches will have inventory**: in stock in time, pre-order, or delayed (and customers need to be told).
3. **Mismatches slip through**: backorders on a product whose card says it's not launched, a vinyl pre-order with no matching PO, and so on.

## 2. Core idea: one record per product (SKU), with a timeline

Everything joins on the **base SKU** (for example `FALRNR103455RD`). Variants (`_MD`, `_OS`…) roll up to it.

```
PO issued ─▶ In ShipHero ─▶ Shipped from vendor ─▶ Delivered ─▶ Receiving ─▶ Received ─▶ Launch-ready
 (email)     (ShipHero PO)    (email + tracking)    (carrier)    (ShipHero)   (ShipHero)   (rules)
```

Each SKU shows: its PO(s), current stage, ETA, inventory, backorders, pre-order status, and the linked Asana launch card with its launch date. Then a **readiness verdict**:

| Verdict | Meaning |
|---|---|
| ✅ **Ready** | Received, on hand > 0, can launch / take off pre-order |
| 🟢 **On track** | ETA before launch date with buffer |
| 🟡 **At risk** | ETA within buffer of launch, or no ETA and launch ≤ 14 days |
| 🔴 **Late** | ETA after launch, or shipped too long ago and not received → pre-order or customer comms needed |
| ⚪ **No PO** | Card or backorders exist but no PO found |

---

## 3. Data sources

| Source | What we get | How |
|---|---|---|
| **Gmail** `globalinboundupdates@` | PO issued, shipped from vendor, tracking, warehouse, production task link, PO PDF | Gmail API (Workspace service account with domain-wide delegation, or OAuth for that mailbox). Poll every 5 min or use Pub/Sub push. Formats in `reference/po-email-formats.md` |
| **ShipHero** (1+ accounts) | POs + line qty received, products, inventory per warehouse (on hand / available / allocated / backorder), backordered orders + order tags | GraphQL API. One refresh token per account; 3PL accounts use `customer_account_id`. PO-update and inventory webhooks if available |
| **Asana** | Launch/campaign cards (launch date, SKUs, pre-order wording, status), production task from the email link | REST API with a personal access token. Campaign card parser ported from `reference/global-launches-page.html` |
| **Carrier tracking** (Phase 3) | Delivered date/ETA for UPS `1Z…` numbers | UPS API or an aggregator (EasyPost / Shippo / AfterShip) |
| **Shopify** (later, optional) | Product status, published, pre-order tag, price | Admin GraphQL per store |
| **Claude API** | Parsing PDFs, matching, audits, summaries (§7) | Anthropic API, structured JSON outputs |

**Pre-order signal: ShipHero product tags** (confirmed). A tag matching a configurable list (default `pre-order`, `preorder`; case-insensitive) on any variant marks the SKU pre-order, with `preorderSource = product_tag`. Pre-order wording on the Asana card is a secondary signal used only for cross-checks (R09/R10), never as the source of truth.

**PO matching (confirmed):** the ShipHero PO number **ends with** the email order number (e.g. email `PO094330` → ShipHero `STOK - PO094330`). Match on `endsWith(orderNo)`, scoped to the warehouse's ShipHero account. If more than one PO matches, raise an Issue instead of guessing.

**Warehouses (confirmed):** email warehouse codes are ShipHero warehouses. Map each code to its ShipHero account + warehouse ID in Settings. Unknown codes raise an Issue.

> Verify every ShipHero query against the current API docs: field names, backorder fields, credit limits. Test PO line statuses on real POs (users report API vs. UI differences).

---

## 4. Stack

- Next.js (App Router) + TypeScript + Tailwind; Postgres + Prisma
- Jobs: cron route handlers or a small worker (queue optional)
- Auth: Google sign-in limited to `@mainfactor.com`
- Secrets in env only (Gmail SA key, ShipHero tokens, Asana PAT, Anthropic key, Slack webhook). Store only a **reference name** to a secret in the DB.

---

## 5. Data model (Prisma sketch)

```prisma
model Store {
  id          String  @id @default(cuid())
  name        String
  code        String  @unique           // SKU prefix: STOK, FALR, MEGA…
  managerId   String?
  manager     User?   @relation(fields: [managerId], references: [id])
  shipheroAccountId String?
  asanaProjectId    String?             // E-Comm board for launch cards
  enabled     Boolean @default(false)   // rollout switch
}

model Warehouse {           // maps email codes to ShipHero warehouses
  id          String  @id @default(cuid())
  emailCode   String  @unique           // "MAINF MI", "BSI UK"
  shipheroAccountId String?
  shipheroWarehouseId String?
  inShiphero  Boolean @default(true)
}

model ShipheroAccount { id String @id @default(cuid()); name String; type String /* direct | 3pl */; tokenRef String; customerAccountId String? }

model Product {             // base SKU
  sku        String  @id                // FALRNR103455RD
  storeId    String
  name       String?                    // Design Name
  isVinyl    Boolean @default(false)
  variants   Variant[]
}

model Variant {
  sku         String  @id               // FALRNR103455RD_MD
  productSku  String
  inShiphero  Boolean @default(false)
  onHand      Int     @default(0)
  available   Int     @default(0)
  allocated   Int     @default(0)
  backorder   Int     @default(0)
  preorder    Boolean @default(false)
  preorderSource String?                // order_tag | product_tag | asana | sell_ahead
  syncedAt    DateTime?
}

model PurchaseOrder {
  id            String   @id @default(cuid())
  orderNo       String                  // PO094330 or SO0058136
  kind          String                  // PO | SO
  warehouseCode String
  stage         String                  // issued | in_shiphero | shipped | delivered | receiving | received | closed
  issuedAt      DateTime?
  shippedAt     DateTime?
  tracking      String[]
  deliveryDate  DateTime?               // from email if present
  etaAt         DateTime?               // best estimate (§6)
  etaSource     String?                 // email | pdf | carrier | lead_time_model
  deliveredAt   DateTime?
  receivedAt    DateTime?
  shipheroId    String?
  productionTaskUrl String?             // Asana link from email
  pdfJson       Json?
  lines         PoLine[]
  @@unique([orderNo, warehouseCode])
}

model PoLine {
  id          String @id @default(cuid())
  poId        String
  productSku  String
  variantSku  String?
  qtyOrdered  Int?                      // from PDF
  qtyShiphero Int?                      // from ShipHero PO
  qtyReceived Int    @default(0)
}

model Campaign {            // Asana launch card (ported parser)
  gid        String   @id
  storeId    String?
  name       String
  kind       String
  launchAt   DateTime?
  endAt      DateTime?
  status     String?
  isPreorder Boolean  @default(false)
  isVinyl    Boolean  @default(false)
  skus       String[]
  permalink  String
  syncedAt   DateTime
}

model CampaignProduct {     // card ↔ SKU link
  campaignGid String
  productSku  String
  source      String                    // parsed | ai | manual
  confidence  Float?
  confirmed   Boolean @default(false)
  @@id([campaignGid, productSku])
}

model Event {               // the timeline
  id         String   @id @default(cuid())
  at         DateTime
  kind       String                     // email_issued, email_shipped, sh_po_created, sh_received, inv_change, card_changed…
  productSku String?
  poId       String?
  data       Json
  sourceUrl  String?                    // Gmail viewUrl, ShipHero link, Asana link
}

model Issue {
  id         String   @id @default(cuid())
  ruleId     String                     // R01… or "ai"
  severity   String                     // red | yellow | info
  title      String
  detail     String
  productSku String?
  poId       String?
  campaignGid String?
  evidence   Json                       // links + values that triggered it
  byAi       Boolean  @default(false)
  status     String   @default("open")  // open | snoozed | resolved | dismissed
  resolution String?                    // reason required on dismiss (feeds AI)
  fingerprint String  @unique           // rule+entities, so re-runs don't duplicate
  firstSeen  DateTime @default(now())
  lastSeen   DateTime
}

model User { id String @id @default(cuid()); email String @unique; name String; stores Store[] }
model SyncRun { id String @id @default(cuid()); job String; startedAt DateTime; finishedAt DateTime?; ok Boolean?; error String?; stats Json? }
```

---

## 6. ETA and readiness logic

ETA, using the first one available:
1. Delivery date in the shipped email
2. Carrier ETA (Phase 3)
3. Date on the PO PDF (ex-factory / ship date)
4. **Lead-time model:** median days from issued → shipped → received, learned from our own history, by product type (vinyl, apparel, hard goods), vendor and warehouse. Show it as an estimate with a range.

Readiness for each SKU vs. its launch card: compare the ETA plus a **receiving buffer of 7 days** (max time from delivery to sellable; configurable) with `launchAt`, and assign a verdict from §2.

---

## 7. Cross-checks: rules first, AI second

**Deterministic rules** run after every sync. They are cheap and predictable, and they are the source of truth for red flags. Each one creates or updates an `Issue` with evidence links.

| ID | Check | Sev |
|---|---|---|
| R01 | PO issued email > 48h ago, no matching ShipHero PO | 🟡 |
| R02 | ShipHero PO qty ≠ PDF qty (per variant) | 🟡 |
| R03 | Email warehouse ≠ ShipHero PO warehouse | 🔴 |
| R04 | Shipped > N days (default 10) and not received | 🟡 |
| R05 | Delivered > 7 days (receiving buffer) and not fully received | 🔴 |
| R06 | **PO received, but SKU still pre-order or has backorders not releasing** → take off pre-order / release | 🔴 |
| R07 | PO received but on hand = 0 (receiving or putaway issue) | 🔴 |
| R08 | **Backorders exist but launch card says not launched yet** (selling early, or card wrong) | 🔴 |
| R09 | **Pre-order on the card or orders but no open PO** for the SKU | 🔴 |
| R10 | Vinyl pre-order card, but the PO is for a different SKU/variant or a different warehouse | 🔴 |
| R11 | Backorder qty > incoming PO qty (short, needs reorder) | 🔴 |
| R12 | **Launch ≤ 14 days and verdict At risk / Late** → decide pre-order vs. delay + customer comms | 🔴 |
| R13 | Launch passed, SKU still not received, no pre-order flag | 🔴 |
| R14 | PO SKU not linked to any launch card (orphan) | info |
| R15 | Launch card SKU has no PO and no inventory | 🟡 |
| R16 | SKU doesn't follow conventions (size suffix `SM, MD, LG, XL, 2XL, 3XL`, `_OS`, underscore) | 🟡 |
| R17 | Email or PDF parsed by AI fallback with low confidence | info |

**AI layer** (Claude API). It never writes to ShipHero or Asana, and only proposes:
- **Parse:** PO PDFs → line items. The email fallback when regex fails.
- **Match:** link POs/SKUs to launch cards when the card doesn't list the SKU (design name vs. card text, dates, store). Creates `CampaignProduct(source=ai, confidence)` for one-click confirm.
- **Daily audit:** for each active SKU, send the joined record (timeline, inventory, backorders, card text + recent comments) and ask for inconsistencies the rules missed. Output is strict JSON `[{title, detail, severity, evidence[]}]` → `Issue(byAi=true)`, shown as "possible issue".
- **Learn from dismissals:** dismissing requires a short reason. Recent resolutions go back into the audit prompt as examples of what's normal.
- **Summaries:** one line per launch: "3 of 4 SKUs received; vinyl shipped Nov 18, ETA Dec 2 → launch Dec 5 at risk."
- **Customer comms draft** (when R12/R13 fire): a short delay or pre-order note the store manager can copy. Never sent automatically.
- Keep prompts in the repo, version them, and keep an eval set of real cases (including the examples above) so prompt changes can be tested.

---

## 8. Screens

Same UX patterns as the current Global Launches dashboard: tiles at the top, one filter row, rows that expand inline, a drawer for full detail, works at ~400px wide.

### 8.1 Today (home)
Tiles: **Needs action** (open red issues) · **Arriving this week** · **Just received** (last 7 days) · **Launches at risk**
Sections:
1. **Just received → act now:** launch it or take it off pre-order (R06/R07).
2. **Launches in the next 14 days:** per card, all SKUs with verdict pills.
3. **Arriving soon:** shipped POs with ETA.
4. **Issues:** grouped by severity, with Resolve / Snooze / Dismiss (with reason).

### 8.2 Inbound (POs)
List grouped by stage (Issued · Shipped · Delivered · Receiving · Received). Row: order #, store, SKU(s), design name, warehouse, age in stage, ETA, received/ordered bar. Expands to show lines, tracking links, timeline, PDF, production task link, and the linked launch card.

### 8.3 Products
One row per base SKU: stage, verdict, on hand / backorder, pre-order badge, launch date. Expands to the full **timeline** (§2) plus linked PO(s) and card.

### 8.4 Launches
Port of Global Launches (List default · Board · Calendar) from `reference/`. Each card's expanded row adds **inventory readiness**: "Vinyl: shipped, ETA Dec 2 · Tee: received ✅".

### 8.5 Settings
Stores (enable for rollout), Warehouses map, ShipHero accounts, thresholds (buffer days, R04 days), Jobs log with "Run now".

### 8.6 Notifications (Slack)
- **Immediate:** PO received (R06), launch late (R12/R13), warehouse mismatch (R03).
- **Daily digest** (morning, per manager): arriving this week, just received, open red issues.

---

## 9. Phases

**Phase 0: Foundation**
Scaffold, auth, Settings (Stores, Warehouses, ShipHero accounts), Jobs log. Seed Troy's stores as `enabled`.

**Phase 1: Know when things arrive** (biggest gap)
1. Gmail ingest (both formats) + PDF parsing → `PurchaseOrder`, `PoLine`, `Event`. Backfill the last 120 days.
2. ShipHero sync: POs (match by order number + warehouse), received qty, products, inventory, backorders, order tags.
3. Inbound and Products screens; rules R01–R07, R11, R16, R17.
4. Slack: "PO received" + daily digest.
**Done when:** every PO email from the last 120 days for Troy's stores shows a correct stage, and receipts in ShipHero appear within 15 min.

**Phase 2: Tie to launches + cross-checks**
1. Asana sync (ported parser) → `Campaign`; card ↔ SKU linking (parsed → AI → manual confirm).
2. Readiness verdicts + ETA (email/PDF dates + lead-time model).
3. Rules R08–R10, R12–R15; Today screen; Launches tab with readiness.
4. AI daily audit + customer comms drafts.

**Phase 3: Accuracy + rollout**
Carrier tracking ETAs, Shopify (optional: product status, published, pre-order tag), enable all client stores, per-manager views and digests.

---

## 10. Decisions (confirmed by Troy)

1. **Warehouses:** email warehouse codes (`MAINF MI`, `BSI UK`…) are ShipHero warehouses. Map each in Settings.
2. **PO numbers:** the ShipHero PO number typically **ends with** the email number (`STOK - PO094330`). Match on suffix. `SO…` numbers follow the same rule.
3. **Pre-order:** ShipHero **product tags**.
4. **Email types:** only the two formats for now. Log any unknown format as an info Issue and keep it, so it can be added later.
5. **Receiving buffer:** **7 days max** from delivery to sellable.

Still to confirm in Phase 0: which ShipHero account each warehouse belongs to, and the exact pre-order tag names in use.

---

## 11. Reference files

- `reference/po-email-formats.md`: both email formats, examples, parsing approach
- `reference/global-launches-page.html`: current dashboard code (Asana card parser, fix logic, UI)
- `reference/global-launches-datasets.json`: current data sources incl. E-Comm board project IDs

## 12. First prompt for Claude Code

> Read `SPEC.md` and everything in `reference/`. Build Phase 0, then Phase 1 step 1 (Gmail ingest + PDF parsing) with unit tests using the email samples in `reference/po-email-formats.md`. Don't hardcode store names, warehouse codes or IDs; they belong in Settings. Use the decisions in §10. Ask me which ShipHero account each warehouse is in and which pre-order tags we use before starting Phase 1 step 2.
