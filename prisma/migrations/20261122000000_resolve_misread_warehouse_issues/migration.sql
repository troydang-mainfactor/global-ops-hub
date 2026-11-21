-- Data fix: an early parser read the email signature into the "Warehouse:" value, raising
-- false ING-WH-MISMATCH issues. Resolve those (body value much longer than any warehouse code).
UPDATE "Issue"
SET "status" = 'resolved', "resolution" = 'False alarm: parser read the email signature as the warehouse (fixed)'
WHERE "ruleId" = 'ING-WH-MISMATCH'
  AND "status" IN ('open', 'snoozed')
  AND length(coalesce("evidence"->>'bodyWarehouse', '')) > 20;
