-- No legacy terminal fields are copied: they have no canonical provenance.
CREATE TABLE "DisputeWorkflow" (
  "id" TEXT NOT NULL,
  "chainId" INTEGER NOT NULL,
  "releaseId" TEXT NOT NULL,
  "contractAddress" TEXT NOT NULL,
  "claimId" TEXT NOT NULL,
  "initiatorAddress" TEXT NOT NULL,
  "reviewStatus" TEXT NOT NULL DEFAULT 'REQUESTED',
  "reviewedBy" TEXT,
  "reviewReason" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "DisputeWorkflow_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DisputeWorkflow_reviewStatus_check" CHECK (
    "reviewStatus" IN ('REQUESTED', 'REVIEWING', 'ACCEPTED_FOR_REVIEW', 'DISMISSED'))
);
CREATE INDEX "DisputeWorkflow_chainId_releaseId_contractAddress_claimId_idx"
  ON "DisputeWorkflow" ("chainId", "releaseId", "contractAddress", "claimId");
