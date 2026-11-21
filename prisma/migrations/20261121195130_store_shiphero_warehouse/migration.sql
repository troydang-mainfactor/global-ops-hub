/*
  Warnings:

  - You are about to drop the column `shipheroAccountId` on the `Warehouse` table. All the data in the column will be lost.
  - You are about to drop the column `shipheroWarehouseId` on the `Warehouse` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "Warehouse" DROP CONSTRAINT "Warehouse_shipheroAccountId_fkey";

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "shipheroWarehouseId" TEXT;

-- AlterTable
ALTER TABLE "Warehouse" DROP COLUMN "shipheroAccountId",
DROP COLUMN "shipheroWarehouseId";
