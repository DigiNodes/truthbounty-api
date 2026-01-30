-- CreateTable SybilScore
CREATE TABLE "SybilScore" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "userId" TEXT NOT NULL,
    "worldcoinScore" REAL NOT NULL DEFAULT 0.0,
    "walletAgeScore" REAL NOT NULL DEFAULT 0.0,
    "stakingScore" REAL NOT NULL DEFAULT 0.0,
    "accuracyScore" REAL NOT NULL DEFAULT 0.0,
    "compositeScore" REAL NOT NULL DEFAULT 0.0,
    "calculationDetails" TEXT,
    CONSTRAINT "SybilScore_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE
);

-- CreateIndex SybilScore_userId_createdAt_unique
CREATE UNIQUE INDEX "SybilScore_userId_createdAt_key" ON "SybilScore"("userId", "createdAt");

-- CreateIndex SybilScore_userId_index
CREATE INDEX "SybilScore_userId_idx" ON "SybilScore"("userId");

-- CreateIndex SybilScore_compositeScore_index
CREATE INDEX "SybilScore_compositeScore_idx" ON "SybilScore"("compositeScore");

-- AlterTable User - Add worldcoinVerified column
ALTER TABLE "User" ADD COLUMN "worldcoinVerified" BOOLEAN NOT NULL DEFAULT 0;
