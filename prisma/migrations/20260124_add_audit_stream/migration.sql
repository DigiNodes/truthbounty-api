-- CreateTable for audit stream records
CREATE TABLE IF NOT EXISTS "audit_stream_records" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "streamId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "previousHash" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "hmacSignature" TEXT NOT NULL,
  "keyId" TEXT NOT NULL,
  "timestamp" INTEGER NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "uq_stream_sequence" UNIQUE("streamId", "sequence")
);

-- CreateTable for audit stream checkpoints
CREATE TABLE IF NOT EXISTS "audit_stream_checkpoints" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "streamId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "headHash" TEXT NOT NULL,
  "keyId" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "uq_stream_checkpoint" UNIQUE("streamId")
);

-- CreateTable for audit key metadata
CREATE TABLE IF NOT EXISTS "audit_key_metadata" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "keyId" TEXT NOT NULL UNIQUE,
  "algorithm" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" DATETIME,
  "isActive" BOOLEAN NOT NULL DEFAULT 1
);

-- Create indexes
CREATE INDEX "idx_stream_sequence" ON "audit_stream_records"("streamId", "sequence");
CREATE INDEX "idx_stream_head" ON "audit_stream_records"("streamId", "createdAt");
CREATE INDEX "idx_checkpoint_stream" ON "audit_stream_checkpoints"("streamId", "sequence");
CREATE INDEX "idx_key_active" ON "audit_key_metadata"("isActive");
CREATE INDEX "idx_key_created" ON "audit_key_metadata"("createdAt");
