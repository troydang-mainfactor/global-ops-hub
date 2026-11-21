"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { DEFAULT_SETTINGS, setSetting, type SettingKey } from "@/lib/settings";
import { normalizeWarehouseCode } from "@/lib/sku";
import { runJob } from "@/lib/jobs/registry";
import { parseStoreCsv } from "@/lib/store-csv";

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const opt = (f: FormData, k: string) => str(f, k) || null;
const done = () => revalidatePath("/settings");

async function managerId(name: string | null): Promise<string | null> {
  if (!name) return null;
  const isEmail = name.includes("@");
  const existing = await db.user.findFirst({ where: isEmail ? { email: name.toLowerCase() } : { name: { equals: name, mode: "insensitive" } } });
  if (existing) return existing.id;
  return (await db.user.create({ data: isEmail ? { email: name.toLowerCase(), name } : { name } })).id;
}

// ---------- Stores
export async function saveStore(f: FormData) {
  await requireUser();
  const id = opt(f, "id");
  const data = {
    name: str(f, "name"),
    code: str(f, "code").toUpperCase(),
    managerId: await managerId(opt(f, "manager")),
    shipheroAccountId: opt(f, "shipheroAccountId"),
    asanaProjectId: opt(f, "asanaProjectId"),
  };
  if (!data.name || !/^[A-Z0-9]{2,8}$/.test(data.code)) throw new Error("Store needs a name and a 2–8 character code");
  if (id) await db.store.update({ where: { id }, data });
  else await db.store.create({ data: { ...data, enabled: f.get("enabled") === "on" } });
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

/** Paste of the "MF store managers" list: store,store_code,manager (header optional). */
export async function importStores(f: FormData) {
  await requireUser();
  const rows = parseStoreCsv(str(f, "csv"));
  for (const r of rows) {
    const mid = await managerId(r.manager);
    await db.store.upsert({
      where: { code: r.code },
      create: { code: r.code, name: r.name, managerId: mid, enabled: false },
      update: { name: r.name, managerId: mid },
    });
  }
  done();
}

// ---------- Warehouses
export async function saveWarehouse(f: FormData) {
  await requireUser();
  const id = opt(f, "id");
  const data = {
    emailCode: normalizeWarehouseCode(str(f, "emailCode")),
    name: opt(f, "name"),
    shipheroAccountId: opt(f, "shipheroAccountId"),
    shipheroWarehouseId: opt(f, "shipheroWarehouseId"),
    inShiphero: f.get("inShiphero") === "on",
  };
  if (!data.emailCode) throw new Error("Warehouse code required");
  if (id) await db.warehouse.update({ where: { id }, data });
  else await db.warehouse.create({ data });
  // Mapping a warehouse (or marking it not-in-ShipHero) resolves its ingest issue.
  if (!data.inShiphero || data.shipheroWarehouseId) {
    await db.issue.updateMany({ where: { fingerprint: `ING-WAREHOUSE:${data.emailCode}`, status: "open" }, data: { status: "resolved", resolution: "Mapped in Settings" } });
  }
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
  const data = { name: str(f, "name"), type: str(f, "type") === "3pl" ? "3pl" : "direct", tokenRef, customerAccountId: opt(f, "customerAccountId") };
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
    if (Array.isArray(def)) {
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
export async function runJobNow(f: FormData) {
  await requireUser();
  await runJob(str(f, "job"), "manual");
  done();
}
