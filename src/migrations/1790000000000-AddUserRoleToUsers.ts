import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration: AddUserRoleToUsers
 *
 * Adds the `role` column to the TypeORM `users` table (PostgreSQL), aligned with
 * the V2 API Authorization Matrix (issue #458).
 *
 * The Prisma plane (SQLite/libsql `User` model) already has this column via
 * prisma/migrations/20260728000000_add_user_role. This migration covers the
 * TypeORM-managed `users` table used by the domain layer.
 *
 * Role values are stored as VARCHAR to avoid enum DDL complexity across
 * PostgreSQL versions. Application-layer validation via the UserRole enum
 * in src/entities/user.entity.ts enforces valid values.
 *
 * Values: 'USER' (default) | 'MODERATOR' | 'ADMIN' | 'SUPER_ADMIN'
 *
 * Rollback: removes the column entirely (no data loss risk — default was 'USER').
 */
export class AddUserRoleToUsers1790000000000 implements MigrationInterface {
  name = 'AddUserRoleToUsers1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Add role column with a safe default so existing rows are not broken.
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "role" VARCHAR(20) NOT NULL DEFAULT 'USER'
    `);

    // Index for role-based queries (used by RolesGuard lookups).
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_users_role"
      ON "users" ("role")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_role"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "role"`);
  }
}
