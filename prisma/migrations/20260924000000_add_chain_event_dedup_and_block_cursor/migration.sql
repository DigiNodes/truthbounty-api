-- Enforce monotonic block cursor compare-and-swap and auditable rollbacks.
-- CreateTable
CREATE TABLE v2_chain_events (
    id TEXT NOT NULL PRIMARY KEY,
    chainId INTEGER NOT NULL,
    contractAddress TEXT NOT NULL,
    eventName TEXT NOT NULL,
    blockNumber BIGINT NOT NULL,
    blockHash TEXT NOT NULL,
    txHash TEXT NOT NULL,
    logIndex INTEGER NOT NULL,
    blockTimestamp DATETIME,
    payload JSONB NOT NULL,
    rawArgs JSONB NOT NULL,
    ingestedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE v2_block_cursors (
    id TEXT NOT NULL PRIMARY KEY,
    chainId INTEGER NOT NULL,
    source TEXT NOT NULL,
    releaseId TEXT NOT NULL,
    projectionId TEXT NOT NULL,
    deploymentBlock BIGINT NOT NULL,
    artifactChecksum TEXT NOT NULL,
    processedHeight BIGINT NOT NULL,
    processedHash TEXT NOT NULL,
    safeHeight BIGINT NOT NULL DEFAULT 0,
    safeHash TEXT NOT NULL DEFAULT '',
    finalizedHeight BIGINT NOT NULL DEFAULT 0,
    finalizedHash TEXT NOT NULL DEFAULT '',
    checkpointHeight BIGINT NOT NULL DEFAULT 0,
    checkpointHash TEXT NOT NULL DEFAULT '',
    checkpointSource TEXT NOT NULL DEFAULT '',
    lastRollbackId TEXT,
    version INTEGER NOT NULL DEFAULT 0,
    updatedAt DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE v2_block_cursor_ancestors (
    id TEXT NOT NULL PRIMARY KEY,
    cursorId TEXT NOT NULL,
    height BIGINT NOT NULL,
    hash TEXT NOT NULL,
    parentHash TEXT NOT NULL,
    isCanonical BOOLEAN NOT NULL DEFAULT true,
    confirmation TEXT NOT NULL DEFAULT 'observed',
    recordedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "v2_block_cursor_ancestors_cursorId_fkey" FOREIGN KEY ("cursorId") REFERENCES "v2_block_cursors" ("id") ON DELETE CASCADE
    ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE v2_block_cursor_rollbacks (
    id TEXT NOT NULL PRIMARY KEY,
    cursorId TEXT NOT NULL,
    chainId INTEGER NOT NULL,
    releaseId TEXT NOT NULL,
    projectionId TEXT NOT NULL,
    fromHeight BIGINT NOT NULL,
    fromHash TEXT NOT NULL,
    toHeight BIGINT NOT NULL,
    toHash TEXT NOT NULL,
    reason TEXT NOT NULL,
    authorizedBy TEXT NOT NULL,
    authorizationRef TEXT NOT NULL,
    auditData JSONB,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "v2_block_cursor_rollbacks_cursorId_fkey" FOREIGN KEY ("cursorId") REFERENCES "v2_block_cursors" ("id") ON DELETE CASCADE
    ON UPDATE CASCADE
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
CREATE UNIQUE INDEX "v2_block_cursors_chainId_source_releaseId_projectionId_key" ON "v2_block_cursors"("chainId", "source", "releaseId", "projectionId");

-- CreateIndex
CREATE INDEX "v2_block_cursors_chainId_releaseId_projectionId_idx" ON "v2_block_cursors"("chainId", "releaseId", "projectionId");

-- CreateIndex
CREATE INDEX "v2_block_cursor_ancestors_cursorId_height_idx" ON "v2_block_cursor_ancestors"("cursorId", "height");

-- CreateIndex
CREATE UNIQUE INDEX "v2_block_cursor_ancestors_cursorId_height_hash_key" ON "v2_block_cursor_ancestors"("cursorId", "height", "hash");

-- CreateIndex
CREATE INDEX "v2_block_cursor_rollbacks_cursorId_createdAt_idx" ON "v2_block_cursor_rollbacks"("cursorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "v2_block_cursor_rollbacks_authorizationRef_key" ON "v2_block_cursor_rollbacks"("authorizationRef");

-- Monotonic cursor advancement guard: processed height must not move backward,
-- and the cursor must never skip past the finalized head or deployment floor.
CREATE TRIGGER "v2_block_cursors_monotonic_guard"
  BEFORE UPDATE OF "processedHeight", "processedHash", "safeHeight", "finalizedHeight", "deploymentBlock", "version"
  ON "v2_block_cursors"
  FOR EACH ROW
  WHEN (
    NEW."processedHeight" < OLD."processedHeight"
    AND NEW."lastRollbackId" IS OLD."lastRollbackId"
  ) BEGIN
    SELECT RAISE(ABORT, 'block cursor cannot move backward without authorized rollback');
  END;

CREATE TRIGGER "v2_block_cursors_hash_agreement_guard"
  BEFORE UPDATE OF "processedHeight", "processedHash", "safeHeight", "finalizedHeight", "deploymentBlock", "version"
  ON "v2_block_cursors"
  FOR EACH ROW
  WHEN (
    NEW."processedHeight" = OLD."processedHeight"
    AND NEW."processedHash" <> OLD."processedHash"
    AND ABS(NEW."version" - OLD."version") <= 1
  ) BEGIN
    SELECT RAISE(ABORT, 'block cursor hash disagreement at same height');
  END;

CREATE TRIGGER "v2_block_cursors_floor_guard"
  BEFORE UPDATE OF "processedHeight", "processedHash", "safeHeight", "finalizedHeight", "deploymentBlock", "version"
  ON "v2_block_cursors"
  FOR EACH ROW
  WHEN (
    NEW."processedHeight" < NEW."deploymentBlock"
    AND ABS(NEW."version" - OLD."version") <= 1
  ) BEGIN
    SELECT RAISE(ABORT, 'block cursor cannot rewind below deployment floor');
  END;

-- Rollbacks must be explicitly authorized and audited.
CREATE TRIGGER "v2_block_cursor_rollbacks_audit_guard"
  BEFORE INSERT ON "v2_block_cursor_rollbacks"
  FOR EACH ROW
  WHEN (
    NEW."authorizedBy" = ''
    OR NEW."authorizationRef" = ''
    OR NEW."reason" = ''
    OR NEW."toHeight" > NEW."fromHeight"
  ) BEGIN
    SELECT RAISE(ABORT, 'block cursor rollback must be authorized, audited, and move backward');
  END;
