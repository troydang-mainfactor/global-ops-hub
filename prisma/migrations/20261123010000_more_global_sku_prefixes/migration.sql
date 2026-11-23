-- Data: remaining Global SKU prefixes confirmed by Troy (Nov 2026). Only added if no store has them yet.
UPDATE "Store" SET "skuPrefixes" = array_append(coalesce("skuPrefixes", '{}'), 'ICRN')
WHERE "name" = 'ICE NINE KILLS' AND NOT EXISTS (SELECT 1 FROM "Store" s WHERE 'ICRN' = ANY(s."skuPrefixes"));
UPDATE "Store" SET "skuPrefixes" = array_append(coalesce("skuPrefixes", '{}'), 'INED')
WHERE "name" = 'ICE NINE KILLS' AND NOT EXISTS (SELECT 1 FROM "Store" s WHERE 'INED' = ANY(s."skuPrefixes"));
UPDATE "Store" SET "skuPrefixes" = array_append(coalesce("skuPrefixes", '{}'), 'SPRT')
WHERE "name" = 'Spiritbox' AND NOT EXISTS (SELECT 1 FROM "Store" s WHERE 'SPRT' = ANY(s."skuPrefixes"));
