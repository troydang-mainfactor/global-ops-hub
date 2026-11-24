-- Data: restart the stalled-receiving timer from ShipHero's own line dates on the next sync.
UPDATE "PurchaseOrder" SET "receivedQty" = NULL, "receivedChangedAt" = NULL;
