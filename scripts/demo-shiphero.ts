// Local UI check only: runs the real ShipHero sync against a fake ShipHero response that partly
// receives demo PO094108 (Falling In Reverse). `npx tsx scripts/demo-shiphero.ts` after `npm run demo`.
import { PrismaClient } from "@prisma/client";
import { runShipheroSync } from "../src/lib/shiphero/sync";
import type { ShipheroClient } from "../src/lib/shiphero/client";

const db = new PrismaClient();
const page = (nodes: unknown[]) => ({ data: { pageInfo: { hasNextPage: false, endCursor: null }, edges: nodes.map((node) => ({ node })) } });
const fake: ShipheroClient = {
  async query<T>(q: string) {
    if (q.includes("account {")) return { account: { data: { id: "A", is_3pl: false, warehouses: [{ id: "WH-MI", identifier: "Primary", active: true }] } } } as T;
    if (q.includes("purchase_orders(")) return { purchase_orders: page([{ id: "DEMO1", legacy_id: 1, po_number: "FALR - PO094108", warehouse_id: "WH-MI", fulfillment_status: "pending", po_date: null, date_closed: null,
      line_items: { edges: [["FALRNR103455RD_SM", 60, 60], ["FALRNR103455RD_MD", 120, 40], ["FALRNR103455RD_LG", 90, 0]].map(([sku, quantity, quantity_received]) => ({ node: { sku, quantity, quantity_received, quantity_rejected: 0, fulfillment_status: "pending" } })) } }]) } as T;
    if (q.includes("warehouse_products(")) return { warehouse_products: page([{ sku: "FALRNR103455RD_MD", warehouse_id: "WH-MI", on_hand: 40, available: 10, allocated: 30, backorder: 25, updated_at: null, product: { name: "Red Logo Tee", sku: "FALRNR103455RD_MD" } }]) } as T;
    return { products: page([{ sku: "FALRNR103455RD_MD", tags: ["pre-order"] }]) } as T;
  },
};
runShipheroSync({ db, clientFor: (a) => (a.warehouseName === "Mainfactor Michigan" ? fake : null) })
  .then((s) => console.log(JSON.stringify(s, null, 1)))
  .finally(() => db.$disconnect());
