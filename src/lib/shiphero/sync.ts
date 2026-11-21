// Phase 1 step 2: ShipHero sync, per account (one login per warehouse).
//  1. Warehouse ID for the account → Store.shipheroWarehouseId
//  2. Purchase orders (incremental by updated_from) → ShipheroPo cache
//  3. Match local POs: ShipHero po_number ENDS WITH the email order number → qty, received, stage
//  4. Inventory (warehouse_products, incremental) → Variant on hand / available / allocated / backorder
//  5. Pre-order = ShipHero product tag (Settings → pre-order tags), case-insensitive
// Resumable: cursors live in SyncState, and each run stops at a time budget.

import { Prisma, type PurchaseOrder, type ShipheroAccount, type Store } from "@prisma/client";
import type { Db } from "../db";
import type { ShipheroClient } from "./client";
import * as Q from "./queries";
import { accountForStore } from "./accounts";
import { baseSku, normalizeSku, storeForSku } from "../sku";
import { laterStage } from "../stages";
import { raiseIssue } from "../issues";
import { getSettings, type Settings } from "../settings";

export interface ShSyncDeps {
  db: Db;
  clientFor: (account: ShipheroAccount) => ShipheroClient | null; // null = no token: skip
  now?: () => Date;
  budgetMs?: number;
}

export interface AccountStats {
  account: string;
  skipped?: string;
  warehouseId?: string | null;
  poPages: number;
  poFetched: number;
  poPassComplete: boolean;
  matched: number;
  ambiguous: number;
  receiving: number;
  received: number;
  inventoryPages: number;
  inventoryRows: number;
  inventoryPassComplete: boolean;
  preorderSkus: number;
  error?: string;
}

type Ctx = { db: Db; now: Date; deadline: number; settings: Settings; stores: Store[] };

interface PassState { updatedFrom: string | null; cursor: string | null; passStartedAt: string | null }

async function getState(db: Db, key: string): Promise<PassState | null> {
  const r = await db.syncState.findUnique({ where: { key } });
  return (r?.value as unknown as PassState) ?? null;
}
async function setState(db: Db, key: string, v: PassState | Record<string, unknown>) {
  await db.syncState.upsert({ where: { key }, create: { key, value: v as Prisma.InputJsonValue }, update: { value: v as Prisma.InputJsonValue } });
}

export async function runShipheroSync(deps: ShSyncDeps): Promise<AccountStats[]> {
  const now = deps.now?.() ?? new Date();
  const ctx: Ctx = {
    db: deps.db, now, deadline: Date.now() + (deps.budgetMs ?? 240_000),
    settings: await getSettings(deps.db), stores: await deps.db.store.findMany(),
  };
  const accounts = await deps.db.shipheroAccount.findMany({ orderBy: { name: "asc" } });
  const out: AccountStats[] = [];
  for (const account of accounts) {
    const stats: AccountStats = {
      account: account.name, poPages: 0, poFetched: 0, poPassComplete: false, matched: 0, ambiguous: 0, receiving: 0, received: 0,
      inventoryPages: 0, inventoryRows: 0, inventoryPassComplete: false, preorderSkus: 0,
    };
    out.push(stats);
    const client = deps.clientFor(account);
    if (!client) {
      stats.skipped = `token not set (${account.tokenRef})`;
      continue;
    }
    try {
      await checkTokenExpiry(ctx, client, account);
      const warehouseId = await syncWarehouse(ctx, client, account);
      stats.warehouseId = warehouseId;
      await syncPurchaseOrders(ctx, client, account, stats);
      await matchPurchaseOrders(ctx, account, stats);
      if (warehouseId) await syncInventory(ctx, client, account, warehouseId, stats);
      await syncPreorderTags(ctx, client, account, stats);
    } catch (e) {
      stats.error = e instanceof Error ? e.message : String(e);
    }
  }
  const failed = out.filter((s) => s.error);
  if (failed.length && failed.length === out.filter((s) => !s.skipped).length) {
    throw new Error(failed.map((f) => `${f.account}: ${f.error}`).join("; "));
  }
  return out;
}

const timeLeft = (ctx: Ctx) => Date.now() < ctx.deadline;
const storesOf = (ctx: Ctx, account: ShipheroAccount, accounts = [account]) =>
  ctx.stores.filter((s) => accountForStore(s, accounts)?.id === account.id);

// ---------------------------------------------------------------- 0. token expiry

/** A pasted access token can't renew itself (28 days): warn a week ahead. */
async function checkTokenExpiry(ctx: Ctx, client: ShipheroClient, account: ShipheroAccount) {
  const exp = client.accessTokenExpiresAt?.() ?? null;
  const fingerprint = `SH-TOKEN:${account.id}`;
  if (!exp || exp.getTime() - ctx.now.getTime() > 7 * 86400000) {
    await ctx.db.issue.updateMany({ where: { fingerprint, status: { in: ["open", "snoozed"] } }, data: { status: "resolved", resolution: "Token replaced" } });
    return;
  }
  const expired = exp <= ctx.now;
  await raiseIssue(ctx.db, {
    ruleId: "SH-TOKEN", severity: expired ? "red" : "yellow",
    title: `ShipHero ${account.name}: access token ${expired ? "expired" : "expires"} ${exp.toISOString().slice(0, 10)}`,
    detail: `Paste a fresh token into ${account.tokenRef}, or switch to a refresh token so it renews itself.`,
    fingerprint, evidence: { account: account.name, tokenRef: account.tokenRef, expiresAt: exp.toISOString() },
  }, ctx.now);
}

// ---------------------------------------------------------------- 1. warehouse

export function pickWarehouse(
  whs: { id: string; identifier: string; active: boolean | null }[],
  warehouseName: string | null,
): { id: string; identifier: string } | null {
  const active = whs.filter((w) => w.active !== false);
  if (active.length === 1) return active[0];
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const want = norm(warehouseName ?? "");
  return active.find((w) => norm(w.identifier) === want) ?? active.find((w) => want && (norm(w.identifier).includes(want) || want.includes(norm(w.identifier)))) ?? null;
}

async function syncWarehouse(ctx: Ctx, client: ShipheroClient, account: ShipheroAccount): Promise<string | null> {
  const r = await client.query<Q.AccountData>(Q.accountWarehouses());
  const wh = pickWarehouse(r.account.data.warehouses ?? [], account.warehouseName);
  if (!wh) {
    await raiseIssue(ctx.db, {
      ruleId: "SH-WAREHOUSE", severity: "yellow",
      title: `ShipHero account "${account.name}": can't tell which warehouse is ${account.warehouseName ?? "its warehouse"}`,
      detail: `Warehouses in this login: ${(r.account.data.warehouses ?? []).map((w) => w.identifier).join(", ") || "none"}. Rename the account's warehouse in Settings to match one of these.`,
      fingerprint: `SH-WAREHOUSE:${account.id}`,
      evidence: { account: account.name, warehouses: (r.account.data.warehouses ?? []).map((w) => w.identifier) },
    }, ctx.now);
    return null;
  }
  const ids = storesOf(ctx, account).filter((s) => s.shipheroWarehouseId !== wh.id).map((s) => s.id);
  if (ids.length) await ctx.db.store.updateMany({ where: { id: { in: ids } }, data: { shipheroWarehouseId: wh.id } });
  await setState(ctx.db, `sh:wh:${account.id}`, { id: wh.id, identifier: wh.identifier });
  return wh.id;
}

// ---------------------------------------------------------------- 2. purchase orders

async function syncPurchaseOrders(ctx: Ctx, client: ShipheroClient, account: ShipheroAccount, stats: AccountStats) {
  const key = `sh:po:${account.id}`;
  const st = (await getState(ctx.db, key)) ?? { updatedFrom: null, cursor: null, passStartedAt: null };
  const updatedFrom = st.updatedFrom ?? new Date(ctx.now.getTime() - ctx.settings.backfillDays * 86400000).toISOString();
  const passStartedAt = st.passStartedAt ?? ctx.now.toISOString();
  let cursor = st.cursor;
  while (timeLeft(ctx)) {
    const r = await client.query<Q.PurchaseOrdersData>(Q.purchaseOrders(updatedFrom, cursor));
    const conn = r.purchase_orders.data;
    stats.poPages++;
    for (const { node } of conn.edges) {
      const lines = node.line_items.edges.map(({ node: l }) => ({
        sku: l.sku, quantity: l.quantity ?? 0, quantityReceived: l.quantity_received ?? 0, quantityRejected: l.quantity_rejected ?? 0, fulfillmentStatus: l.fulfillment_status,
      }));
      const data = {
        accountId: account.id, poNumber: node.po_number, warehouseId: node.warehouse_id, fulfillmentStatus: node.fulfillment_status,
        poDate: node.po_date ? new Date(node.po_date) : null, dateClosed: node.date_closed ? new Date(node.date_closed) : null,
        lines: { legacyId: node.legacy_id, items: lines } as Prisma.InputJsonValue, syncedAt: ctx.now,
      };
      await ctx.db.shipheroPo.upsert({ where: { id: node.id }, create: { id: node.id, ...data }, update: data });
      stats.poFetched++;
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    if (!cursor) {
      stats.poPassComplete = true;
      // Next pass: everything updated since this pass began (1h overlap for clock skew).
      await setState(ctx.db, key, { updatedFrom: new Date(new Date(passStartedAt).getTime() - 3600000).toISOString(), cursor: null, passStartedAt: null });
      return;
    }
  }
  await setState(ctx.db, key, { updatedFrom, cursor, passStartedAt });
}

// ---------------------------------------------------------------- 3. match + apply

/** The PO/SO number a ShipHero po_number ends with: "STOK - PO094330" → "PO094330". */
export function trailingOrderNo(poNumber: string): string | null {
  return poNumber.trim().toUpperCase().match(/(?:^|[^A-Z0-9])((?:PO|SO)\d+)$/)?.[1] ?? null;
}

interface ShLine { sku: string; quantity: number; quantityReceived: number; quantityRejected: number; fulfillmentStatus: string | null }

async function matchPurchaseOrders(ctx: Ctx, account: ShipheroAccount, stats: AccountStats) {
  const { db } = ctx;
  const storeIds = storesOf(ctx, account).map((s) => s.id);
  if (!storeIds.length) return;
  const shPos = await db.shipheroPo.findMany({ where: { accountId: account.id } });
  const byNo = new Map<string, typeof shPos>();
  for (const p of shPos) {
    const no = trailingOrderNo(p.poNumber);
    if (no) byNo.set(no, [...(byNo.get(no) ?? []), p]);
  }
  const locals = await db.purchaseOrder.findMany({ where: { storeId: { in: storeIds }, stage: { not: "closed" } } });
  for (const po of locals) {
    const cands = byNo.get(po.orderNo) ?? [];
    if (cands.length > 1) {
      stats.ambiguous++;
      await raiseIssue(db, {
        ruleId: "SH-PO-MULTI", severity: "yellow",
        title: `${po.orderNo}: ${cands.length} ShipHero POs end with this number`,
        detail: `Not guessing which one. ShipHero POs: ${cands.map((c) => c.poNumber).join(", ")}.`,
        fingerprint: `SH-PO-MULTI:${po.id}`, poId: po.id,
        evidence: { orderNo: po.orderNo, shipheroPos: cands.map((c) => c.poNumber) },
      }, ctx.now);
      continue;
    }
    if (cands.length === 1) {
      await applyShipheroPo(ctx, po, cands[0], stats);
      stats.matched++;
    }
  }
}

async function applyShipheroPo(ctx: Ctx, po: PurchaseOrder, sh: { id: string; poNumber: string; dateClosed: Date | null; fulfillmentStatus: string | null; lines: Prisma.JsonValue }, stats: AccountStats) {
  const { db } = ctx;
  const raw = sh.lines as unknown as { legacyId?: number | null; items: ShLine[] };
  const agg = new Map<string, { productSku: string; variantSku: string | null; qty: number; rec: number }>();
  for (const l of raw.items ?? []) {
    if (!l.sku) continue;
    const sku = normalizeSku(l.sku);
    const cur = agg.get(sku) ?? { productSku: baseSku(sku), variantSku: sku.includes("_") ? sku : null, qty: 0, rec: 0 };
    cur.qty += l.quantity;
    cur.rec += l.quantityReceived;
    agg.set(sku, cur);
  }

  for (const [lineKey, l] of agg) {
    const storeId = storeForSku(l.productSku, ctx.stores)?.store.id ?? po.storeId;
    await db.product.upsert({ where: { sku: l.productSku }, create: { sku: l.productSku, storeId }, update: {} });
    if (l.variantSku) await db.variant.upsert({ where: { sku: l.variantSku }, create: { sku: l.variantSku, productSku: l.productSku }, update: {} });
    await db.poLine.upsert({
      where: { poId_lineKey: { poId: po.id, lineKey } },
      create: { poId: po.id, lineKey, productSku: l.productSku, variantSku: l.variantSku, qtyShiphero: l.qty, qtyReceived: l.rec },
      update: { qtyShiphero: l.qty, qtyReceived: l.rec },
    });
  }
  const sized = [...new Set([...agg.values()].filter((l) => l.variantSku).map((l) => l.productSku))];
  if (sized.length) {
    await db.poLine.deleteMany({ where: { poId: po.id, variantSku: null, qtyOrdered: null, qtyShiphero: null, productSku: { in: sized } } });
  }

  const total = [...agg.values()].reduce((a, l) => a + l.qty, 0);
  const rec = [...agg.values()].reduce((a, l) => a + l.rec, 0);
  // Progress is judged on quantities, not status text (API and UI statuses can differ).
  const shStage = total > 0 && rec >= total ? "received" : rec > 0 ? "receiving" : "in_shiphero";
  const stage = laterStage(po.stage, shStage);
  const data: Prisma.PurchaseOrderUpdateInput = { stage, shipheroId: sh.id };
  if (stage === "received" && !po.receivedAt) data.receivedAt = sh.dateClosed ?? ctx.now;
  await db.purchaseOrder.update({ where: { id: po.id }, data });

  const link = raw.legacyId ? `https://app.shiphero.com/dashboard/purchase-orders/details/${raw.legacyId}` : null;
  const ev = async (kind: string, at: Date) =>
    db.event.upsert({
      where: { dedupeKey: `sh:${po.id}:${kind}` },
      create: {
        at, kind, poId: po.id, productSku: [...agg.values()][0]?.productSku ?? null, sourceUrl: link, dedupeKey: `sh:${po.id}:${kind}`,
        data: { orderNo: po.orderNo, shipheroPo: sh.poNumber, received: rec, ordered: total, status: sh.fulfillmentStatus },
      },
      update: {},
    });
  await ev("sh_po_matched", ctx.now);
  if (rec > 0) {
    await ev("sh_receiving", ctx.now);
    stats.receiving++;
  }
  if (stage === "received") {
    await ev("sh_received", (data.receivedAt as Date | undefined) ?? po.receivedAt ?? ctx.now);
    stats.received++;
  }
}

// ---------------------------------------------------------------- 4. inventory

async function syncInventory(ctx: Ctx, client: ShipheroClient, account: ShipheroAccount, warehouseId: string, stats: AccountStats) {
  const key = `sh:wp:${account.id}`;
  const st = (await getState(ctx.db, key)) ?? { updatedFrom: null, cursor: null, passStartedAt: null };
  const passStartedAt = st.passStartedAt ?? ctx.now.toISOString();
  let cursor = st.cursor;
  while (timeLeft(ctx)) {
    const r = await client.query<Q.WarehouseProductsData>(Q.warehouseProducts(warehouseId, st.updatedFrom, cursor));
    const conn = r.warehouse_products.data;
    stats.inventoryPages++;
    for (const { node } of conn.edges) {
      if (!node.sku) continue;
      const sku = normalizeSku(node.sku);
      const productSku = baseSku(sku);
      const storeId = storeForSku(productSku, ctx.stores)?.store.id ?? null;
      await ctx.db.product.upsert({
        where: { sku: productSku },
        create: { sku: productSku, storeId, name: node.product?.name ?? null },
        update: storeId ? { storeId } : {},
      });
      const inv = {
        inShiphero: true, onHand: node.on_hand ?? 0, available: node.available ?? 0, allocated: node.allocated ?? 0,
        backorder: node.backorder ?? 0, syncedAt: ctx.now, shipheroAccountId: account.id,
      };
      await ctx.db.variant.upsert({ where: { sku }, create: { sku, productSku, ...inv }, update: inv });
      stats.inventoryRows++;
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
    if (!cursor) {
      stats.inventoryPassComplete = true;
      await setState(ctx.db, key, { updatedFrom: new Date(new Date(passStartedAt).getTime() - 3600000).toISOString(), cursor: null, passStartedAt: null });
      return;
    }
  }
  await setState(ctx.db, key, { updatedFrom: st.updatedFrom, cursor, passStartedAt });
}

// ---------------------------------------------------------------- 5. pre-order tags

/** Case variants to send, since ShipHero's tag filter may be case-sensitive. */
export function tagVariants(tags: string[]): string[] {
  const cap = (t: string) => t.replace(/(^|[\s-])([a-z])/g, (_m, a, b) => a + b.toUpperCase());
  return [...new Set(tags.flatMap((t) => [t, t.toLowerCase(), t.toUpperCase(), cap(t.toLowerCase())]))];
}

async function syncPreorderTags(ctx: Ctx, client: ShipheroClient, account: ShipheroAccount, stats: AccountStats) {
  const wanted = ctx.settings.preorderTags.map((t) => t.toLowerCase());
  if (!wanted.length) return;
  const tagged = new Map<string, string[]>();
  let cursor: string | null = null;
  do {
    if (!timeLeft(ctx)) return; // incomplete: don't clear flags on a partial list
    const r: Q.ProductsData = await client.query<Q.ProductsData>(Q.productsByTag(tagVariants(ctx.settings.preorderTags), cursor));
    const conn: Q.Conn<{ sku: string; tags: string[] | null }> = r.products.data;
    for (const { node } of conn.edges) {
      const tags = node.tags ?? [];
      if (node.sku && tags.some((t) => wanted.includes(t.toLowerCase()))) tagged.set(normalizeSku(node.sku), tags);
    }
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (cursor);

  const skus = [...tagged.keys()];
  for (const [sku, tags] of tagged) {
    await ctx.db.variant.updateMany({ where: { sku }, data: { preorder: true, preorderSource: "product_tag", tags } });
  }
  // Tag removed in ShipHero → no longer pre-order (only for flags this account set).
  await ctx.db.variant.updateMany({
    where: { shipheroAccountId: account.id, preorderSource: "product_tag", sku: { notIn: skus } },
    data: { preorder: false, preorderSource: null },
  });
  stats.preorderSkus = skus.length;
}

