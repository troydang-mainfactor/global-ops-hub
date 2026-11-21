-- AlterTable
ALTER TABLE "Variant" ADD COLUMN     "shipheroAccountId" TEXT,
ADD COLUMN     "tags" TEXT[];

-- CreateTable
CREATE TABLE "ShipheroPo" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "poNumber" TEXT NOT NULL,
    "warehouseId" TEXT,
    "fulfillmentStatus" TEXT,
    "poDate" TIMESTAMP(3),
    "dateClosed" TIMESTAMP(3),
    "lines" JSONB NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShipheroPo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncState" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "ShipheroPo_accountId_idx" ON "ShipheroPo"("accountId");

