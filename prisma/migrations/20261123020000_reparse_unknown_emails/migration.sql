-- Data: the email parser now reads "[Shipped]"/"[New Order]" tagged subjects, "[no value]" order
-- numbers (from the PDF) and signatures on the warehouse line. Forget emails it couldn't read before,
-- so the next Gmail backfill reads them again (they are still in Gmail).
UPDATE "Issue" SET "status" = 'resolved', "resolution" = 'Re-reading with the updated parser'
WHERE "ruleId" = 'ING-FORMAT' AND "status" IN ('open', 'snoozed');
DELETE FROM "EmailMessage" WHERE "status" IN ('unknown_format', 'error');

UPDATE "Issue"
SET "status" = 'resolved', "resolution" = 'False alarm: parser read the email signature as the warehouse (fixed)'
WHERE "ruleId" = 'ING-WH-MISMATCH'
  AND "status" IN ('open', 'snoozed')
  AND length(coalesce("evidence"->>'bodyWarehouse', '')) > 20;
