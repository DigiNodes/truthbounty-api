-- PREWAVE-BE-103: Persistent Sybil Score Appeals with Provenance
-- CreateTable SybilAppeal
CREATE TABLE "SybilAppeal" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "appealId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "reason" TEXT NOT NULL,
    "previousScore" DOUBLE PRECISION NOT NULL,
    "previousRiskScore" DOUBLE PRECISION NOT NULL,
    "newScore" DOUBLE PRECISION NOT NULL,
    "newRiskScore" DOUBLE PRECISION NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "recomputedAt" TIMESTAMP(3) NOT NULL,
    "provenanceDigest" TEXT NOT NULL,
    "additionalEvidenceSummary" TEXT,
    "reviewerId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNotes" TEXT,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "SybilAppeal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SybilAppeal_appealId_key" ON "SybilAppeal"("appealId");

-- CreateIndex
CREATE UNIQUE INDEX "SybilAppeal_idempotencyKey_key" ON "SybilAppeal"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SybilAppeal_userId_createdAt_idx" ON "SybilAppeal"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "SybilAppeal_status_createdAt_idx" ON "SybilAppeal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SybilAppeal_appealId_idx" ON "SybilAppeal"("appealId");

-- CreateIndex
CREATE INDEX "SybilAppeal_userId_status_idx" ON "SybilAppeal"("userId", "status");

-- CreateIndex
CREATE INDEX "SybilAppeal_idempotencyKey_idx" ON "SybilAppeal"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SybilAppeal_modelVersion_idx" ON "SybilAppeal"("modelVersion");

-- AddForeignKey
ALTER TABLE "SybilAppeal" ADD CONSTRAINT "SybilAppeal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
