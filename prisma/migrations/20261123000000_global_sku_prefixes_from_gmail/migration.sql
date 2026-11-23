-- Data: Global SKU prefixes found in the PO emails (Nov 2026), matched to stores by name and design names.
-- Adds a prefix only if no store already has it, so edits made in Settings are kept.
UPDATE "Store" SET "skuPrefixes" = array_append(coalesce("skuPrefixes", '{}'), 'CHIO')
WHERE "name" = 'Chiodos' AND NOT EXISTS (SELECT 1 FROM "Store" s WHERE 'CHIO' = ANY(s."skuPrefixes"));
UPDATE "Store" SET "skuPrefixes" = array_append(coalesce("skuPrefixes", '{}'), 'CHEL')
WHERE "name" = 'Chelsea Wolfe' AND NOT EXISTS (SELECT 1 FROM "Store" s WHERE 'CHEL' = ANY(s."skuPrefixes"));
UPDATE "Store" SET "skuPrefixes" = array_append(coalesce("skuPrefixes", '{}'), 'SLAS')
WHERE "name" = 'Slash' AND NOT EXISTS (SELECT 1 FROM "Store" s WHERE 'SLAS' = ANY(s."skuPrefixes"));
UPDATE "Store" SET "skuPrefixes" = array_append(coalesce("skuPrefixes", '{}'), 'DANC')
WHERE "name" = 'Dance Gavin Dance' AND NOT EXISTS (SELECT 1 FROM "Store" s WHERE 'DANC' = ANY(s."skuPrefixes"));
UPDATE "Store" SET "skuPrefixes" = array_append(coalesce("skuPrefixes", '{}'), 'SKIB')
WHERE "name" = 'Skibidi' AND NOT EXISTS (SELECT 1 FROM "Store" s WHERE 'SKIB' = ANY(s."skuPrefixes"));
UPDATE "Store" SET "skuPrefixes" = array_append(coalesce("skuPrefixes", '{}'), 'TLTO')
WHERE "name" = 'The Living Tombstone' AND NOT EXISTS (SELECT 1 FROM "Store" s WHERE 'TLTO' = ANY(s."skuPrefixes"));
UPDATE "Store" SET "skuPrefixes" = array_append(coalesce("skuPrefixes", '{}'), 'INXS')
WHERE "name" = 'INXS' AND NOT EXISTS (SELECT 1 FROM "Store" s WHERE 'INXS' = ANY(s."skuPrefixes"));
UPDATE "Store" SET "skuPrefixes" = array_append(coalesce("skuPrefixes", '{}'), 'FRKJ')
WHERE "name" = 'FKJ (French Kiwi Juice)' AND NOT EXISTS (SELECT 1 FROM "Store" s WHERE 'FRKJ' = ANY(s."skuPrefixes"));
UPDATE "Store" SET "skuPrefixes" = array_append(coalesce("skuPrefixes", '{}'), 'ICEN')
WHERE "name" = 'ICE NINE KILLS' AND NOT EXISTS (SELECT 1 FROM "Store" s WHERE 'ICEN' = ANY(s."skuPrefixes"));
UPDATE "Store" SET "skuPrefixes" = array_append(coalesce("skuPrefixes", '{}'), 'ICGH')
WHERE "name" = 'ICE NINE KILLS' AND NOT EXISTS (SELECT 1 FROM "Store" s WHERE 'ICGH' = ANY(s."skuPrefixes"));
UPDATE "Store" SET "skuPrefixes" = array_append(coalesce("skuPrefixes", '{}'), 'ICDD')
WHERE "name" = 'ICE NINE KILLS' AND NOT EXISTS (SELECT 1 FROM "Store" s WHERE 'ICDD' = ANY(s."skuPrefixes"));
UPDATE "Store" SET "skuPrefixes" = array_append(coalesce("skuPrefixes", '{}'), 'INTR')
WHERE "name" = 'ICE NINE KILLS' AND NOT EXISTS (SELECT 1 FROM "Store" s WHERE 'INTR' = ANY(s."skuPrefixes"));
UPDATE "Store" SET "skuPrefixes" = array_append(coalesce("skuPrefixes", '{}'), 'STOK')
WHERE "name" = 'Sleep Token' AND NOT EXISTS (SELECT 1 FROM "Store" s WHERE 'STOK' = ANY(s."skuPrefixes"));
UPDATE "Store" SET "skuPrefixes" = array_append(coalesce("skuPrefixes", '{}'), 'FALR')
WHERE "name" = 'Falling In Reverse' AND NOT EXISTS (SELECT 1 FROM "Store" s WHERE 'FALR' = ANY(s."skuPrefixes"));
UPDATE "Store" SET "skuPrefixes" = array_append(coalesce("skuPrefixes", '{}'), 'MEGA')
WHERE "name" = 'Megadeth' AND NOT EXISTS (SELECT 1 FROM "Store" s WHERE 'MEGA' = ANY(s."skuPrefixes"));
UPDATE "Store" SET "skuPrefixes" = array_append(coalesce("skuPrefixes", '{}'), 'EVAN')
WHERE "name" = 'Evanescence' AND NOT EXISTS (SELECT 1 FROM "Store" s WHERE 'EVAN' = ANY(s."skuPrefixes"));
