-- CreateTable
CREATE TABLE "v2_chain_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" INTEGER NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "blockHash" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "blockTimestamp" DATETIME,
    "payload" JSONB NOT NULL,
    "rawArgs" JSONB NOT NULL,
    "ingestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "v2_block_cursors" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chainId" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "processedHeight" BIGINT NOT NULL,
    "processedHash" TEXT NOT NULL,
    "safeHeight" BIGINT NOT NULL DEFAULT 0,
    "safeHash" TEXT NOT NULL DEFAULT '',
    "finalizedHeight" BIGINT NOT NULL DEFAULT 0,
    "finalizedHash" TEXT NOT NULL DEFAULT '',
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "v2_block_cursor_ancestors" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cursorId" TEXT NOT NULL,
    "height" BIGINT NOT NULL,
    "hash" TEXT NOT NULL,
    "parentHash" TEXT NOT NULL,
    "isCanonical" BOOLEAN NOT NULL DEFAULT true,
    "confirmation" TEXT NOT NULL DEFAULT 'observed',
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "v2_block_cursor_ancestors_cursorId_fkey" FOREIGN KEY ("cursorId") REFERENCES "v2_block_cursors" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "v2_chain_events_chainId_blockNumber_idx" ON "v2_chain_events"("chainId", "blockNumber");

-- CreateIndex
CREATE INDEX "v2_chain_events_eventName_blockNumber_idx" ON "v2_chain_events"("eventName", "blockNumber");

-- CreateIndex
CREATE INDEX "v2_chain_events_contractAddress_idx" ON "v2_chain_events"("contractAddress");

-- CreateIndex
CREATE UNIQUE INDEX "v2_chain_events_chainId_blockHash_txHash_logIndex_key" ON "v2_chain_events"("chainId", "blockHash", "txHash", "logIndex");

-- CreateIndex
CREATE UNIQUE INDEX "v2_block_cursors_chainId_source_key" ON "v2_block_cursors"("chainId", "source");

-- CreateIndex
CREATE INDEX "v2_block_cursor_ancestors_cursorId_height_idx" ON "v2_block_cursor_ancestors"("cursorId", "height");

-- CreateIndex
CREATE UNIQUE INDEX "v2_block_cursor_ancestors_cursorId_height_hash_key" ON "v2_block_cursor_ancestors"("cursorId", "height", "hash");

