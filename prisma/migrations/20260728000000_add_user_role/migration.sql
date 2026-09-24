-- AlterTable User - Add role column (UserRole enum stored as TEXT in SQLite)
ALTER TABLE "User" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'contributor';
