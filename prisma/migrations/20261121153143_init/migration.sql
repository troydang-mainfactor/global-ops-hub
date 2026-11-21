-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "managerId" TEXT,
    "shipheroAccountId" TEXT,
    "asanaProjectId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Warehouse" (
    "id" TEXT NOT NULL,
    "emailCode" TEXT NOT NULL,
    "name" TEXT,
    "shipheroAccountId" TEXT,
    "shipheroWarehouseId" TEXT,
    "inShiphero" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipheroAccount" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "tokenRef" TEXT NOT NULL,
    "customerAccountId" TEXT,

    CONSTRAINT "ShipheroAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "sku" TEXT NOT NULL,
    "storeId" TEXT,
    "name" TEXT,
    "isVinyl" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("sku")
);

-- CreateTable
CREATE TABLE "Variant" (
    "sku" TEXT NOT NULL,
    "productSku" TEXT NOT NULL,
    "inShiphero" BOOLEAN NOT NULL DEFAULT false,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "available" INTEGER NOT NULL DEFAULT 0,
    "allocated" INTEGER NOT NULL DEFAULT 0,
    "backorder" INTEGER NOT NULL DEFAULT 0,
    "preorder" BOOLEAN NOT NULL DEFAULT false,
    "preorderSource" TEXT,
    "syncedAt" TIMESTAMP(3),

    CONSTRAINT "Variant_pkey" PRIMARY KEY ("sku")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "warehouseCode" TEXT NOT NULL,
    "storeId" TEXT,
    "stage" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3),
    "shippedAt" TIMESTAMP(3),
    "tracking" TEXT[],
    "deliveryDate" TIMESTAMP(3),
    "etaAt" TIMESTAMP(3),
    "etaSource" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "shipheroId" TEXT,
    "productionTaskUrl" TEXT,
    "pdfJson" JSONB,
    "pdfSource" JSONB,
    "pdfAttempts" INTEGER NOT NULL DEFAULT 0,
    "pdfError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PoLine" (
    "id" TEXT NOT NULL,
    "poId" TEXT NOT NULL,
    "lineKey" TEXT NOT NULL,
    "productSku" TEXT NOT NULL,
    "variantSku" TEXT,
    "qtyOrdered" INTEGER,
    "qtyShiphero" INTEGER,
    "qtyReceived" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PoLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "gid" TEXT NOT NULL,
    "storeId" TEXT,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "launchAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "status" TEXT,
    "isPreorder" BOOLEAN NOT NULL DEFAULT false,
    "isVinyl" BOOLEAN NOT NULL DEFAULT false,
    "skus" TEXT[],
    "permalink" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("gid")
);

-- CreateTable
CREATE TABLE "CampaignProduct" (
    "campaignGid" TEXT NOT NULL,
    "productSku" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CampaignProduct_pkey" PRIMARY KEY ("campaignGid","productSku")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "productSku" TEXT,
    "poId" TEXT,
    "data" JSONB NOT NULL,
    "sourceUrl" TEXT,
    "dedupeKey" TEXT,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Issue" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "productSku" TEXT,
    "poId" TEXT,
    "campaignGid" TEXT,
    "evidence" JSONB NOT NULL,
    "byAi" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'open',
    "snoozedUntil" TIMESTAMP(3),
    "resolution" TEXT,
    "fingerprint" TEXT NOT NULL,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "ok" BOOLEAN,
    "error" TEXT,
    "stats" JSONB,
    "trigger" TEXT,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "from" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "skipReason" TEXT,
    "parsedBy" TEXT,
    "confidence" DOUBLE PRECISION,
    "parsed" JSONB,
    "baseSku" TEXT,
    "storeCode" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Store_code_key" ON "Store"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Warehouse_emailCode_key" ON "Warehouse"("emailCode");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_orderNo_warehouseCode_key" ON "PurchaseOrder"("orderNo", "warehouseCode");

-- CreateIndex
CREATE INDEX "PoLine_productSku_idx" ON "PoLine"("productSku");

-- CreateIndex
CREATE UNIQUE INDEX "PoLine_poId_lineKey_key" ON "PoLine"("poId", "lineKey");

-- CreateIndex
CREATE UNIQUE INDEX "Event_dedupeKey_key" ON "Event"("dedupeKey");

-- CreateIndex
CREATE INDEX "Event_productSku_at_idx" ON "Event"("productSku", "at");

-- CreateIndex
CREATE INDEX "Event_poId_at_idx" ON "Event"("poId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "Issue_fingerprint_key" ON "Issue"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "EmailMessage_status_idx" ON "EmailMessage"("status");

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_shipheroAccountId_fkey" FOREIGN KEY ("shipheroAccountId") REFERENCES "ShipheroAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Warehouse" ADD CONSTRAINT "Warehouse_shipheroAccountId_fkey" FOREIGN KEY ("shipheroAccountId") REFERENCES "ShipheroAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_productSku_fkey" FOREIGN KEY ("productSku") REFERENCES "Product"("sku") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PoLine" ADD CONSTRAINT "PoLine_poId_fkey" FOREIGN KEY ("poId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
