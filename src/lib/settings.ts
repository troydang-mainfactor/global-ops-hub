// Thresholds and lists editable in Settings. Defaults follow SPEC §6, §7, §10.
import type { Db } from "./db";

export const DEFAULT_SETTINGS = {
  receivingBufferDays: 7, // delivery → sellable (§10.5)
  shippedNotReceivedDays: 10, // R04
  issuedNoShipheroHours: 48, // R01
  launchWindowDays: 14, // R12 / At risk
  preorderTags: ["pre-order", "preorder"], // ShipHero product tags (§3), case-insensitive
  backfillDays: 120, // Phase 1 backfill window
  incrementalDays: 3, // how far back each 5-minute poll looks (idempotent, so overlap is fine)
  aiLowConfidence: 0.8, // below this an AI parse raises R17
  pdfMaxPerRun: 25, // caps Claude PDF calls per job run; the rest wait for the next run
};
export type Settings = typeof DEFAULT_SETTINGS;
export type SettingKey = keyof Settings;

export async function getSettings(db: Db): Promise<Settings> {
  const rows = await db.setting.findMany();
  const out = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const r of rows) if (r.key in out) out[r.key] = r.value;
  return out as Settings;
}

export async function setSetting<K extends SettingKey>(db: Db, key: K, value: Settings[K]) {
  await db.setting.upsert({ where: { key }, create: { key, value: value as never }, update: { value: value as never } });
}
