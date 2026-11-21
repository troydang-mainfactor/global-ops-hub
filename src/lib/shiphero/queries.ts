// GraphQL text for the ShipHero queries we use. Field names follow developer.shiphero.com
// (schema + examples, read Nov 2026). Values are inlined with JSON.stringify to avoid
// depending on exact scalar type names (DateTime vs ISODateTime).
// Page sizes are kept small: complexity ≈ page size × nested page size and the pool is 4004 credits.

const q = (v: unknown) => JSON.stringify(v);
const after = (cursor: string | null) => (cursor ? `, after: ${q(cursor)}` : "");

export const PO_PAGE = 10;
export const PO_LINES = 50;
export const WP_PAGE = 100;
export const PRODUCT_PAGE = 100;

export interface PageInfo { hasNextPage: boolean; endCursor: string | null }
export interface Conn<T> { pageInfo: PageInfo; edges: { node: T }[] }
export interface Result<T> { request_id?: string; complexity?: number; data: T }

export const accountWarehouses = () => `query {
  account { request_id complexity data { id is_3pl warehouses { id legacy_id identifier profile active } } }
}`;
export interface ShWarehouse { id: string; identifier: string; profile: string | null; active: boolean | null }
export interface AccountData { account: Result<{ id: string; is_3pl: boolean | null; warehouses: ShWarehouse[] }> }

export const purchaseOrders = (updatedFrom: string, cursor: string | null) => `query {
  purchase_orders(updated_from: ${q(updatedFrom)}) {
    request_id complexity
    data(first: ${PO_PAGE}${after(cursor)}) {
      pageInfo { hasNextPage endCursor }
      edges { node {
        id legacy_id po_number warehouse_id fulfillment_status po_date date_closed
        line_items(first: ${PO_LINES}) { edges { node { sku quantity quantity_received quantity_rejected fulfillment_status } } }
      } }
    }
  }
}`;
export interface ShPoNode {
  id: string;
  legacy_id: number | null;
  po_number: string;
  warehouse_id: string | null;
  fulfillment_status: string | null;
  po_date: string | null;
  date_closed: string | null;
  line_items: { edges: { node: { sku: string; quantity: number | null; quantity_received: number | null; quantity_rejected: number | null; fulfillment_status: string | null } }[] };
}
export interface PurchaseOrdersData { purchase_orders: Result<Conn<ShPoNode>> }

export const warehouseProducts = (warehouseId: string, updatedFrom: string | null, cursor: string | null) => `query {
  warehouse_products(warehouse_id: ${q(warehouseId)}${updatedFrom ? `, updated_from: ${q(updatedFrom)}` : ""}) {
    request_id complexity
    data(first: ${WP_PAGE}${after(cursor)}) {
      pageInfo { hasNextPage endCursor }
      edges { node { sku warehouse_id on_hand available allocated backorder updated_at product { name sku } } }
    }
  }
}`;
export interface WpNode { sku: string; warehouse_id: string; on_hand: number | null; available: number | null; allocated: number | null; backorder: number | null; updated_at: string | null; product: { name: string | null; sku: string } | null }
export interface WarehouseProductsData { warehouse_products: Result<Conn<WpNode>> }

export const productsByTag = (tags: string[], cursor: string | null) => `query {
  products(tag: ${q(tags)}) {
    request_id complexity
    data(first: ${PRODUCT_PAGE}${after(cursor)}) {
      pageInfo { hasNextPage endCursor }
      edges { node { sku tags } }
    }
  }
}`;
export interface ProductsData { products: Result<Conn<{ sku: string; tags: string[] | null }>> }

