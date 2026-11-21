# Inbound PO email formats

Source mailbox: `globalinboundupdates@mainfactor.com`
Sender seen: `jonathan.stanley@globalmerchservices.com`, sent through Asana (each email links an Asana production task).
Samples taken Nov 2026. Build the parser against real messages and keep these as test fixtures.

---

## 1. PO issued ("New Order")

**Subject:** `New Order {SKU}/ {ORDER_NO}/ {WAREHOUSE}`

Examples:
- `New Order STOKNR104581OT/ PO094330/ MAINF MI`
- `New Order EVANRX103143BK/ PO094352/ MAINF MI`
- `New Order STOKRX004233OT/ SO0058136/ BSI UK`   ← `SO` number, UK warehouse

**Body (plain text):**
```
A new production order has been issued to a vendor for {SKU}. Please follow the Asana Link to the task to find the PO document.

SKU: {SKU}
Design Name: {DESIGN NAME}
Order Type: {New | …}

Sent from Asana: https://app.asana.com/1/{workspace}/project/{project_id}/task/{task_id}
```

**Attachments:** `Purchase Order {ORDER_NO}.pdf` (line items, sizes, quantities, maybe dates) plus a product image.

**Notes:**
- `{SKU}` is the **base/style SKU** (for example `FALRNR103455RD`). Variant SKUs add a size suffix (`_SM`, `_MD`, `_OS`…). Match on prefix.
- One PO number can cover several SKUs, with one email per SKU (for example PO094108 → FALRNR103452BL, …453GN, …454OT, …455RD, …456BL, …457OT).
- The Asana link points to a **production board task** (seen: project `1210225902154346`). This is not the E-Comm campaign card.

---

## 2. Shipped from vendor

**Subject:** `{ORDER_NO} /{SKU} / {WAREHOUSE}`   (optional suffix after SKU, e.g. `MEGARX203613GR - Hand Cuffs (Component)`)

Examples:
- `PO094108 /FALRNR103455RD / MAINF MI`
- `PO093125 /MEGARX203613GR - Hand Cuffs (Component) / MAINF MI`

**Body (plain text):**
```
{SKU} has shipped from the vendor. Please see tracking below and the Asana Task Link for the PO & packing list documents.

{SKU}
{Design Name}
Tracking:
{TRACKING}/{TRACKING}/…        ← slash-separated, UPS 1Z… seen
Delivery Date:
{date | [no value]}
Warehouse:
{WAREHOUSE}

Sent from Asana: https://app.asana.com/1/{workspace}/project/{project_id}/task/{task_id}
```

**Attachments:** PO PDF (+ packing list sometimes) and an image.

---

## Warehouse codes seen
| Code in email | Meaning (confirm) | In ShipHero? (confirm) |
|---|---|---|
| `MAINF MI` | Mainfactor warehouse | ? |
| `BSI UK` | UK warehouse (SO numbers) | ? |

## Parsing approach
1. Regex on subject + body (fast, free). Covers both formats above.
2. If the regex fails or a field is missing, fall back to the Claude API with a strict JSON schema, and flag the message `parsed_by_ai`.
3. PO PDF → Claude API (PDF input) → line items `{sku, size, qty, unit_cost?, ex_factory_date?, ship_date?}`. Store the raw JSON.
4. Idempotent by Gmail message ID. Label processed messages `ops-hub/processed`.
