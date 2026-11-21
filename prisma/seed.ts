// Seeds the store list (seed-stores.tsv), enables Troy's open stores, adds Global SKU prefix guesses
// to stores that have none, and the known warehouse codes. Safe to re-run: keeps edits made in Settings.
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import data from "./seed-data.json";
import { parseStoreCsv } from "../src/lib/store-csv";
import { importStoreRows } from "../src/lib/store-import";

const db = new PrismaClient();

async function main() {
  const m = data.manager;
  await db.user.upsert({ where: { email: m.email }, create: { email: m.email, name: m.name }, update: {} });

  const rows = parseStoreCsv(readFileSync(path.join(__dirname, "seed-stores.tsv"), "utf8"));
  const res = await importStoreRows(db, rows, { enableManager: data.enableManager });

  for (const [name, prefixes] of Object.entries(data.skuPrefixGuesses)) {
    const s = await db.store.findUnique({ where: { name } });
    if (s && s.skuPrefixes.length === 0) await db.store.update({ where: { id: s.id }, data: { skuPrefixes: prefixes } });
  }
  for (const w of data.warehouses) {
    await db.warehouse.upsert({ where: { emailCode: w.emailCode }, create: w, update: {} });
  }
  const enabled = await db.store.count({ where: { enabled: true } });
  console.log(`Stores: ${res.created} created, ${res.updated} updated, ${enabled} enabled. Warehouses: ${data.warehouses.length}.`);
}

main().finally(() => db.$disconnect());
