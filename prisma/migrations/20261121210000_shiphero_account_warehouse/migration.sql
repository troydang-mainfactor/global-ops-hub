-- AlterTable
ALTER TABLE "ShipheroAccount" ADD COLUMN     "warehouseName" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ShipheroAccount_warehouseName_key" ON "ShipheroAccount"("warehouseName");

