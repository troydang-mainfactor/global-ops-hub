import type { ShipheroAccount, Store } from "@prisma/client";

/** The ShipHero account a store's POs and inventory live in: the override if set, else the one for its warehouse. */
export function accountForStore<A extends Pick<ShipheroAccount, "id" | "warehouseName">>(
  store: Pick<Store, "shipheroAccountId" | "warehouseName">,
  accounts: A[],
): A | null {
  if (store.shipheroAccountId) return accounts.find((a) => a.id === store.shipheroAccountId) ?? null;
  const wh = store.warehouseName?.trim().toLowerCase();
  return (wh && accounts.find((a) => a.warehouseName?.trim().toLowerCase() === wh)) || null;
}

/** True when the env var named by tokenRef holds a value. The token itself is never stored in the DB. */
export function tokenSet(account: Pick<ShipheroAccount, "tokenRef">): boolean {
  return Boolean(process.env[account.tokenRef]);
}
