// Seeds Troy's stores (enabled) and the known warehouse codes. Safe to re-run: never
// overwrites names, managers or mappings edited in Settings.
import { PrismaClient } from "@prisma/client";
import data from "./seed-data.json";

const db = new PrismaClient();

async function main() {
  const m = data.manager;
  const manager = await db.user.upsert({ where: { email: m.email }, create: { email: m.email, name: m.name }, update: {} });
  for (const s of data.stores) {
    await db.store.upsert({
      where: { code: s.code },
      create: { code: s.code, name: s.name, enabled: s.enabled, managerId: manager.id },
      update: {},
    });
  }
  for (const w of data.warehouses) {
    await db.warehouse.upsert({ where: { emailCode: w.emailCode }, create: w, update: {} });
  }
  console.log(`Seeded ${data.stores.length} stores for ${m.name}, ${data.warehouses.length} warehouses.`);
}

main().finally(() => db.$disconnect());
