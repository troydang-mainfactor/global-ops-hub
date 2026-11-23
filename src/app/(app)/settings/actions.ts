"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { DEFAULT_SETTINGS, setSetting, type SettingKey } from "@/lib/settings";
import { normalizePrefixes, normalizeWarehouseCode } from "@/lib/sku";
import { importStoreRows, managerIdFor } from "@/lib/store-import";
import { executeRun, startJob } from "@/lib/jobs/registry";
import { after } from "next/server";
import { parseStoreCsv } from "@/lib/store-csv";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const opt = (f: FormData, k: string) => str(f, k) || null;
const done = () => revalidatePath("/settings");

const managerId = (name: string | null) => managerIdFor(db, name);

/** A Global SKU prefix may belong to one store only. */
async function assertPrefixesFree(prefixes: string[], storeId: string | null) {
  if (!prefixes.length) return;
  const clash = await db.store.findFirst({ where: { skuPrefixes: { hasSome: prefixes }, ...(storeId ? { NOT: { id: storeId } } : {}) } });
  if (clash) throw new Error(`SKU prefix already used by ${clash.name}: ${clash.skuPrefixes.filter((p) => prefixes.includes(p)).join(", ")}`);
}

// ---------- Stores
export async function saveStore(f: FormData) {
  await requireUser();
  const id = opt(f, "id");
  const code = str(f, "code").toUpperCase() || null;
  const data = {
    name: str(f, "name"),
    code,
    skuPrefixes: normalizePrefixes(str(f, "skuPrefixes")),
    managerId: await managerId(opt(f, "manager")),
    warehouseName: opt(f, "warehouseName"),
    shipheroProfile: opt(f, "shipheroProfile"),
    asanaProjectId: opt(f, "asanaProjectId"),
  };
  if (!data.name) throw new Error("Store needs a name");
  if (code && !/^[A-Z0-9]{2,8}$/.test(code)) throw new Error("Store code must be 2–8 letters/digits");
  await assertPrefixesFree(data.skuPrefixes, id);
  if (id) {
    const before = await db.store.findUnique({ where: { id }, select: { shipheroProfile: true } });
    // A new profile name is re-matched on the next ShipHero sync.
    const reset = before && before.shipheroProfile !== data.shipheroProfile ? { shipheroWarehouseId: null } : {};
    await db.store.update({ where: { id }, data: { ...data, ...reset } });
  } else await db.store.create({ data: { ...data, enabled: f.get("enabled") === "on" } });
  if (id && data.warehouseName) {
    await db.issue.updateMany({ where: { fingerprint: `ING-STORE-WAREHOUSE:${id}`, status: "open" }, data: { status: "resolved", resolution: "Set in Settings" } });
  }
  done();
}

/** From the "unmatched SKUs" list: add a Global prefix to a store. Its emails are picked up on the next run. */
export async function assignPrefix(f: FormData) {
  await requireUser();
  const storeId = str(f, "storeId");
  const [prefix] = normalizePrefixes(str(f, "prefix"));
  if (!storeId || !prefix) return;
  await assertPrefixesFree([prefix], storeId);
  const s = await db.store.findUniqueOrThrow({ where: { id: storeId } });
  await db.store.update({ where: { id: storeId }, data: { skuPrefixes: [...new Set([...s.skuPrefixes, prefix])] } });
  done();
}

export async function toggleStore(f: FormData) {
  await requireUser();
  const id = str(f, "id");
  const s = await db.store.findUniqueOrThrow({ where: { id } });
  await db.store.update({ where: { id }, data: { enabled: !s.enabled } });
  done();
}

export async function deleteStore(f: FormData) {
  await requireUser();
  await db.store.delete({ where: { id: str(f, "id") } });
  done();
}

export async function enableManagerStores(f: FormData) {
  await requireUser();
  const mid = str(f, "managerId");
  await db.store.updateMany({ where: { managerId: mid }, data: { enabled: f.get("enabled") === "1" } });
  done();
}

/** Paste of the store managers sheet (columns matched by header). New stores start disabled. */
export async function importStores(f: FormData) {
  await requireUser();
  await importStoreRows(db, parseStoreCsv(str(f, "csv")));
  done();
}

// ---------- Warehouses
export async function saveWarehouse(f: FormData) {
  await requireUser();
  const id = opt(f, "id");
  const data = {
    emailCode: normalizeWarehouseCode(str(f, "emailCode")),
    name: opt(f, "name"),
    inShiphero: f.get("inShiphero") === "on",
  };
  if (!data.emailCode) throw new Error("Warehouse code required");
  if (id) await db.warehouse.update({ where: { id }, data });
  else await db.warehouse.create({ data });
  // Reviewing a new code in Settings resolves its FYI issue.
  await db.issue.updateMany({ where: { fingerprint: `ING-WAREHOUSE:${data.emailCode}`, status: "open" }, data: { status: "resolved", resolution: "Reviewed in Settings" } });
  done();
}

export async function deleteWarehouse(f: FormData) {
  await requireUser();
  await db.warehouse.delete({ where: { id: str(f, "id") } });
  done();
}

// ---------- ShipHero accounts
export async function saveShipheroAccount(f: FormData) {
  await requireUser();
  const id = opt(f, "id");
  const tokenRef = str(f, "tokenRef").toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(tokenRef)) throw new Error("Token ref must be an env var NAME like SHIPHERO_TOKEN_MAIN, not the token");
  const data = { name: str(f, "name"), warehouseName: opt(f, "warehouseName"), type: str(f, "type") === "3pl" ? "3pl" : "direct", tokenRef, customerAccountId: opt(f, "customerAccountId") };
  if (id) await db.shipheroAccount.update({ where: { id }, data });
  else await db.shipheroAccount.create({ data });
  done();
}

export async function deleteShipheroAccount(f: FormData) {
  await requireUser();
  await db.shipheroAccount.delete({ where: { id: str(f, "id") } });
  done();
}

// ---------- Thresholds
export async function saveThresholds(f: FormData) {
  await requireUser();
  for (const key of Object.keys(DEFAULT_SETTINGS) as SettingKey[]) {
    const raw = f.get(key);
    if (raw === null) continue;
    const def = DEFAULT_SETTINGS[key];
    if (typeof def === "string") {
      const v = String(raw).trim();
      if (v) await setSetting(db, key, v as never); // never save an empty Gmail filter
    } else if (Array.isArray(def)) {
      const list = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
      await setSetting(db, key, list as never);
    } else {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) await setSetting(db, key, n as never);
    }
  }
  done();
}

// ---------- Jobs
/** Starts the job in the background (after the response), so the page stays usable. */
export async function runJobNow(f: FormData) {
  await requireUser();
  const name = str(f, "job");
  const s = await startJob(name, "manual");
  if (s.started) after(() => executeRun(name, s.runId).then(() => undefined));
  done();
}
