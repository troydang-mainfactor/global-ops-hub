-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "closed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "globalManager" TEXT,
ADD COLUMN     "shopifyAdminUrl" TEXT,
ADD COLUMN     "skuPrefixes" TEXT[],
ADD COLUMN     "tier" TEXT,
ADD COLUMN     "warehouseName" TEXT,
ALTER COLUMN "code" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Store_name_key" ON "Store"("name");

