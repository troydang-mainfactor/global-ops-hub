export const STAGES = ["issued", "in_shiphero", "shipped", "delivered", "receiving", "received", "closed"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  issued: "Issued",
  in_shiphero: "In ShipHero",
  shipped: "Shipped",
  delivered: "Delivered",
  receiving: "Receiving",
  received: "Received",
  closed: "Closed",
};

/** Stages only move forward. */
export function laterStage(a: string | null | undefined, b: string): Stage {
  const ia = a ? STAGES.indexOf(a as Stage) : -1;
  const ib = STAGES.indexOf(b as Stage);
  return (ia >= ib ? a : b) as Stage;
}
