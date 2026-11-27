import { MigrationInterface, QueryRunner } from 'typeorm';
import { THEMES } from '../theme.entity';

export class PersistUserThemePreferences1793200000000
  implements MigrationInterface
{
  name = 'PersistUserThemePreferences1793200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    if (queryRunner.connection.options.type !== 'postgres') {
      throw new Error('Theme preference persistence requires PostgreSQL');
    }

    const allowedThemes = THEMES.map((theme) => `'${theme}'`).join(',');

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "user_theme_preferences" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "userId" varchar(255) NOT NULL,
      "theme" varchar(10) NOT NULL,
      "createdAt" timestamptz NOT NULL DEFAULT now(),
      "updatedAt" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_user_theme_preferences" PRIMARY KEY ("id"),
      CONSTRAINT "CHK_user_theme_preferences_theme" CHECK ("theme" IN (${allowedThemes}))
    )`);

    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_user_theme_preferences_userId"
      ON "user_theme_preferences" ("userId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "user_theme_preferences"`);
  }
}
