-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "receivedChangedAt" TIMESTAMP(3),
ADD COLUMN     "receivedQty" INTEGER,
ADD COLUMN     "shipheroClosedAt" TIMESTAMP(3);


-- Troy: ignore the INXS warehouse note (its POs go to Michigan on purpose).
UPDATE "Issue" SET "status" = 'dismissed', "resolution" = 'Ignore (Troy): INXS POs go to Mainfactor Michigan'
WHERE "ruleId" = 'ING-STORE-WH' AND "title" LIKE 'INXS:%' AND "status" IN ('open', 'snoozed', 'resolved');
