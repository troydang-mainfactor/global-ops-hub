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
import { runInboundRules } from "../rules/inbound";

export interface ShSyncDeps {
  db: Db;
  clientFor: (account: ShipheroAccount) => ShipheroClient | null; // null = no token: skip
  now?: () => Date;
  budgetMs?: number;
}

export interface AccountStats {
  account: string;
  skipped?: string;
  warehouses?: number; // warehouses in the login
  storesMatched?: number; // stores whose ShipHero warehouse was found (by profile)
  storesUnmatched?: string[]; // enabled stores with no matching profile
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
      await syncWarehouses(ctx, client, account, stats);
      await syncPurchaseOrders(ctx, client, account, stats);
      await matchPurchaseOrders(ctx, account, stats);
      // Inventory per enabled store's warehouse (each store has its own warehouse/profile).
      const whIds = [...new Set(storesOf(ctx, account).filter((st) => st.enabled && st.shipheroWarehouseId).map((st) => st.shipheroWarehouseId!))];
      stats.inventoryPassComplete = true;
      for (const whId of whIds) {
        if (!timeLeft(ctx)) { stats.inventoryPassComplete = false; break; }
        const done = await syncInventory(ctx, client, account, whId, stats);
        if (!done) stats.inventoryPassComplete = false;
      }
      await syncPreorderTags(ctx, client, account, stats);
    } catch (e) {
      stats.error = e instanceof Error ? e.message : String(e);
    }
  }
  await runInboundRules(deps.db, now);
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

// ---------------------------------------------------------------- 1. warehouses (one per store, by profile)

const norm = (v: string | null | undefined) => (v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The ShipHero warehouse for a store. In a login with one warehouse per store, warehouses are told
 * apart by `profile`, which matches the store name (or Store.shipheroProfile when set).
 * A login with a single active warehouse serves every store.
 */
export function warehouseForStore(
  store: { name: string; code: string | null; shipheroProfile: string | null },
  whs: Q.ShWarehouse[],
): Q.ShWarehouse | null {
  const active = whs.filter((w) => w.active !== false);
  if (active.length === 1) return active[0];
  const wants = store.shipheroProfile ? [norm(store.shipheroProfile)] : [norm(store.name), norm(store.code)].filter(Boolean);
  const exact = active.filter((w) => wants.includes(norm(w.profile)));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1 || store.shipheroProfile) return null;
  const loose = active.filter((w) => {
    const p = norm(w.profile);
    return p.length >= 4 && norm(store.name).length >= 4 && (p.includes(norm(store.name)) || norm(store.name).includes(p));
  });
  return loose.length === 1 ? loose[0] : null;
}

async function syncWarehouses(ctx: Ctx, client: ShipheroClient, account: ShipheroAccount, stats: AccountStats) {
  const { db } = ctx;
  const r = await client.query<Q.AccountData>(Q.accountWarehouses());
  const whs = r.account.data.warehouses ?? [];
  stats.warehouses = whs.length;
  const profiles = [...new Set(whs.filter((w) => w.active !== false).map((w) => w.profile).filter(Boolean) as string[])].sort();
  await setState(db, `sh:wh:${account.id}`, { profiles, count: whs.length });
  await db.issue.updateMany({ where: { fingerprint: `SH-WAREHOUSE:${account.id}`, status: "open" }, data: { status: "resolved", resolution: "Warehouses now matched per store by profile" } });

  let matched = 0;
  const unmatched: string[] = [];
  for (const store of storesOf(ctx, account)) {
    const wh = warehouseForStore(store, whs);
    if ((wh?.id ?? null) !== store.shipheroWarehouseId) {
      await db.store.update({ where: { id: store.id }, data: { shipheroWarehouseId: wh?.id ?? null } });
      store.shipheroWarehouseId = wh?.id ?? null; // keep ctx.stores current for later steps
    }
    const fingerprint = `SH-PROFILE:${store.id}`;
    if (wh) {
      matched++;
      await db.issue.updateMany({ where: { fingerprint, status: "open" }, data: { status: "resolved", resolution: `Matched ShipHero profile ${wh.profile ?? wh.identifier}` } });
    } else if (store.enabled) {
      unmatched.push(store.name);
      await raiseIssue(db, {
        ruleId: "SH-PROFILE", severity: "yellow",
        title: `${store.name}: no ShipHero profile matches in ${account.name}`,
        detail: `Set the store's ShipHero profile in Settings → Stores to the exact profile name used in ShipHero${store.shipheroProfile ? ` ("${store.shipheroProfile}" wasn't found)` : ""}.`,
        fingerprint,
        evidence: { store: store.name, account: account.name, profiles: profiles.slice(0, 100) },
      }, ctx.now);
    }
  }
  stats.storesMatched = matched;
  stats.storesUnmatched = unmatched;
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
        sku: l.sku, quantity: l.quantity ?? 0, quantityReceived: l.quantity_received ?? 0, quantityRejected: l.quantity_rejected ?? 0, fulfillmentStatus: l.fulfillment_status, updatedAt: l.updated_at ?? null,
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

/**
 * Matching key for an order number, tolerant of how it's written in ShipHero:
 * "STOK - PO094330", "PO 094330", "PO94330 STOK" and "PO094330" all give "PO94330".
 * Uses the last PO/SO/TO number in the text.
 */
export function orderKey(text: string | null | undefined): string | null {
  const all = [...(text ?? "").toUpperCase().matchAll(/(?:^|[^A-Z0-9])(PO|SO|TO)[\s#:-]?0*(\d{3,})(?![0-9])/g)];
  const m = all.at(-1);
  return m ? `${m[1]}${m[2]}` : null;
}

/** The PO/SO number a ShipHero po_number ends with: "STOK - PO094330" → "PO094330". */
export function trailingOrderNo(poNumber: string): string | null {
  return poNumber.trim().toUpperCase().match(/(?:^|[^A-Z0-9])((?:PO|SO|TO)\d+)$/)?.[1] ?? null;
}

interface ShLine { sku: string; quantity: number; quantityReceived: number; quantityRejected: number; fulfillmentStatus: string | null; updatedAt?: string | null }

async function matchPurchaseOrders(ctx: Ctx, account: ShipheroAccount, stats: AccountStats) {
  const { db } = ctx;
  const storeIds = storesOf(ctx, account).map((s) => s.id);
  if (!storeIds.length) return;
  const shPos = await db.shipheroPo.findMany({ where: { accountId: account.id } });
  const byNo = new Map<string, typeof shPos>();
  for (const p of shPos) {
    const no = orderKey(p.poNumber);
    if (no) byNo.set(no, [...(byNo.get(no) ?? []), p]);
  }
  const locals = await db.purchaseOrder.findMany({ where: { storeId: { in: storeIds }, stage: { not: "closed" } } });
  const whOf = new Map(ctx.stores.map((st) => [st.id, st.shipheroWarehouseId]));
  for (const po of locals) {
    // Cancelled ShipHero POs never count.
    const all = (byNo.get(orderKey(po.orderNo) ?? po.orderNo) ?? []).filter((c) => !isCancelled(c));
    // Prefer ShipHero POs in the store's own warehouse (one warehouse per store).
    const storeWh = po.storeId ? whOf.get(po.storeId) : null;
    const inWh = storeWh ? all.filter((c) => c.warehouseId === storeWh) : [];
    const cands = inWh.length ? inWh : all;
    // Global often splits one PO into a ShipHero PO per SKU ("FALR… - PO094108" ×6).
    // Those cover different SKUs, so combine them. Overlapping SKUs = real duplicates: don't guess.
    // Duplicates with the same SKUs (e.g. one cancelled, one closed): prefer the one that actually
    // received stock, else the only one still open.
    const picked = cands.length > 1 ? pickDuplicate(cands) : null;
    if (picked) {
      await applyShipheroPo(ctx, po, picked, stats);
      await db.issue.updateMany({ where: { fingerprint: `SH-PO-MULTI:${po.id}`, status: "open" }, data: { status: "resolved", resolution: `Used ${picked.poNumber} (received stock / still open)` } });
      stats.matched++;
      continue;
    }
    const merged = cands.length > 1 ? mergeSplitPos(cands) : null;
    if (merged) {
      await applyShipheroPo(ctx, po, merged, stats);
      await db.issue.updateMany({ where: { fingerprint: `SH-PO-MULTI:${po.id}`, status: "open" }, data: { status: "resolved", resolution: "Combined: ShipHero POs cover different SKUs" } });
      stats.matched++;
      continue;
    }
    if (cands.length > 1) {
      stats.ambiguous++;
      await raiseIssue(db, {
        ruleId: "SH-PO-MULTI", severity: "yellow",
        title: `${po.orderNo}: ${cands.length} ShipHero POs end with this number`,
        detail: `They share SKUs, so not guessing which one. ShipHero POs: ${cands.map((c) => `${c.poNumber} (${c.fulfillmentStatus ?? "no status"})`).join(", ")}. Close or cancel the extra one in ShipHero, or dismiss with a note.`,
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

const receivedOf = (c: ShPoRow) => ((c.lines as unknown as { items?: ShLine[] })?.items ?? []).reduce((a, l) => a + (l.quantityReceived ?? 0), 0);
const skusOf = (c: ShPoRow) => new Set(((c.lines as unknown as { items?: ShLine[] })?.items ?? []).filter((l) => l.sku).map((l) => normalizeSku(l.sku)));

/** Among ShipHero POs that share SKUs (true duplicates), the one to use, or null to raise an issue. */
export function pickDuplicate(cands: ShPoRow[]): ShPoRow | null {
  const sets = cands.map(skusOf);
  const overlap = sets.some((a, i) => sets.some((b, j) => j > i && [...a].some((x) => b.has(x))));
  if (!overlap) return null; // split by SKU: combine instead
  const withStock = cands.filter((c) => receivedOf(c) > 0);
  if (withStock.length === 1) return withStock[0];
  const open = cands.filter((c) => !c.dateClosed && !/closed|cancel/i.test(c.fulfillmentStatus ?? ""));
  if (open.length === 1) return open[0];
  return null;
}

/** Cancelled in ShipHero: PO status says so, or every line is cancelled. */
function isCancelled(c: { fulfillmentStatus: string | null; lines: Prisma.JsonValue }): boolean {
  if (/cancel/i.test(c.fulfillmentStatus ?? "")) return true;
  const items = ((c.lines as unknown as { items?: ShLine[] })?.items ?? []);
  return items.length > 0 && items.every((l) => /cancel/i.test(l.fulfillmentStatus ?? ""));
}

type ShPoRow = { id: string; poNumber: string; dateClosed: Date | null; fulfillmentStatus: string | null; lines: Prisma.JsonValue };

/** Combines ShipHero POs that split one order by SKU. Returns null if any SKU appears in more than one. */
export function mergeSplitPos(cands: ShPoRow[]): ShPoRow | null {
  const seen = new Set<string>();
  const items: ShLine[] = [];
  for (const c of cands) {
    const raw = c.lines as unknown as { items?: ShLine[] };
    const skus = new Set((raw.items ?? []).filter((l) => l.sku).map((l) => normalizeSku(l.sku)));
    for (const s of skus) {
      if (seen.has(s)) return null;
      seen.add(s);
    }
    items.push(...(raw.items ?? []));
  }
  const firstLegacy = (cands[0].lines as unknown as { legacyId?: number | null }).legacyId ?? null;
  const allClosed = cands.every((c) => c.dateClosed);
  return {
    id: cands.map((c) => c.id).join(","),
    poNumber: cands.map((c) => c.poNumber).join(", "),
    dateClosed: allClosed ? new Date(Math.max(...cands.map((c) => c.dateClosed!.getTime()))) : null,
    fulfillmentStatus: [...new Set(cands.map((c) => c.fulfillmentStatus).filter(Boolean))].join(", ") || null,
    lines: { legacyId: firstLegacy, items } as unknown as Prisma.JsonValue,
  };
}

async function applyShipheroPo(ctx: Ctx, po: PurchaseOrder, sh: ShPoRow, stats: AccountStats) {
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
  const data: Prisma.PurchaseOrderUpdateInput = { stage, shipheroId: sh.id, shipheroClosedAt: sh.dateClosed };
  if (po.receivedQty !== rec) {
    // First time we see this PO: the stall timer starts when ShipHero last changed a line, not now.
    const lastLineChange = (raw.items ?? []).map((l) => (l.updatedAt ? new Date(l.updatedAt).getTime() : NaN)).filter((t) => !Number.isNaN(t));
    const since = po.receivedQty == null && lastLineChange.length ? new Date(Math.max(...lastLineChange)) : ctx.now;
    Object.assign(data, { receivedQty: rec, receivedChangedAt: since });
  }
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

/** Returns true when this warehouse's pass finished (false = stopped at the time budget). */
async function syncInventory(ctx: Ctx, client: ShipheroClient, account: ShipheroAccount, warehouseId: string, stats: AccountStats): Promise<boolean> {
  const key = `sh:wp:${account.id}:${warehouseId}`;
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
      await setState(ctx.db, key, { updatedFrom: new Date(new Date(passStartedAt).getTime() - 3600000).toISOString(), cursor: null, passStartedAt: null });
      return true;
    }
  }
  await setState(ctx.db, key, { updatedFrom: st.updatedFrom, cursor, passStartedAt });
  return false;
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

