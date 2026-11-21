import type { Db } from "./db";
import type { StoreRow } from "./store-csv";

/** Finds a manager by email, exact name, or first name ("Troy" → "Troy Dang"); creates one if missing. */
export async function managerIdFor(db: Db, name: string | null): Promise<string | null> {
  if (!name) return null;
  const n = name.trim();
  if (n.includes("@")) {
    const u = await db.user.findUnique({ where: { email: n.toLowerCase() } });
    return u?.id ?? (await db.user.create({ data: { email: n.toLowerCase(), name: n } })).id;
  }
  const exact = await db.user.findFirst({ where: { name: { equals: n, mode: "insensitive" } } });
  if (exact) return exact.id;
  const first = await db.user.findMany({ where: { name: { startsWith: `${n} `, mode: "insensitive" } } });
  if (first.length === 1) return first[0].id;
  return (await db.user.create({ data: { name: n } })).id;
}

/**
 * Upserts stores from the pasted list, matched by store code, else by name.
 * New stores start disabled (closed ones always disabled). Existing enabled flags,
 * ShipHero settings and SKU prefixes are kept unless the sheet has a prefix column.
 */
export async function importStoreRows(db: Db, rows: StoreRow[], opts: { enableManager?: string } = {}) {
  let created = 0, updated = 0;
  for (const r of rows) {
    const managerId = await managerIdFor(db, r.manager);
    const existing =
      (r.code ? await db.store.findUnique({ where: { code: r.code } }) : null) ?? (await db.store.findUnique({ where: { name: r.name } }));
    const enable = !r.closed && Boolean(opts.enableManager && r.manager && r.manager.toLowerCase() === opts.enableManager.toLowerCase());
    const data = {
      name: r.name, code: r.code, managerId, globalManager: r.globalManager, tier: r.tier, warehouseName: r.warehouseName,
      shopifyAdminUrl: r.shopifyAdminUrl, closed: r.closed,
      ...(r.skuPrefixes ? { skuPrefixes: r.skuPrefixes } : {}),
    };
    if (existing) {
      await db.store.update({ where: { id: existing.id }, data: { ...data, ...(r.closed ? { enabled: false } : enable ? { enabled: true } : {}) } });
      updated++;
    } else {
      await db.store.create({ data: { ...data, skuPrefixes: r.skuPrefixes ?? [], enabled: enable } });
      created++;
    }
  }
  return { created, updated };
}
