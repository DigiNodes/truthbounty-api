import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  isTheme,
  THEMES,
  Theme,
  UserThemePreference,
} from './theme.entity';

export { THEMES } from './theme.entity';
export type { Theme } from './theme.entity';

export interface ThemePreference {
  theme: Theme;
  userId?: string;
  updatedAt: Date;
}

@Injectable()
export class ThemeService {
  private readonly defaultTheme: Theme = 'system';

  constructor(
    @InjectRepository(UserThemePreference)
    private readonly repository: Repository<UserThemePreference>,
  ) {}

  async getTheme(userId?: string): Promise<Theme> {
    if (!userId) {
      return this.defaultTheme;
    }

    const record = await this.repository.findOne({ where: { userId } });
    return record && isTheme(record.theme) ? record.theme : this.defaultTheme;
  }

  async setTheme(theme: Theme, userId?: string): Promise<ThemePreference> {
    this.assertTheme(theme);

    if (!userId) {
      return this.clientScopedPreference(theme);
    }

    return this.persistTheme(userId, theme);
  }

  async getResolvedTheme(userId?: string): Promise<'light' | 'dark'> {
    const theme = await this.getTheme(userId);
    return theme === 'system' ? 'light' : theme;
  }

  async toggleTheme(
    userId?: string,
    currentTheme?: Theme,
  ): Promise<ThemePreference> {
    if (!userId) {
      this.assertTheme(currentTheme ?? this.defaultTheme);
      const source = currentTheme ?? this.defaultTheme;
      const nextTheme: Theme = source === 'light' ? 'dark' : 'light';
      return this.clientScopedPreference(nextTheme);
    }

    const rows = await this.repository.query(
      `INSERT INTO "user_theme_preferences" ("userId", "theme")
       VALUES ($1, $2)
       ON CONFLICT ("userId") DO UPDATE
         SET "theme" = CASE WHEN "user_theme_preferences"."theme" = 'light' THEN 'dark' ELSE 'light' END,
             "updatedAt" = now()
       RETURNING "theme", "userId", "updatedAt"`,
      [userId, 'light'],
    );

    const saved = rows?.[0];
    if (!saved || !isTheme(saved.theme)) {
      throw new InternalServerErrorException('Theme preference was not persisted');
    }

    return {
      theme: saved.theme,
      userId: saved.userId,
      updatedAt: saved.updatedAt,
    };
  }

  async resetToSystem(userId?: string): Promise<ThemePreference> {
    return this.setTheme(this.defaultTheme, userId);
  }

  async getThemeStats(): Promise<{ light: number; dark: number; system: number }> {
    const counts = await Promise.all(
      THEMES.map((theme) => this.repository.count({ where: { theme } })),
    );

    return {
      light: counts[0],
      dark: counts[1],
      system: counts[2],
    };
  }

  private assertTheme(theme: unknown): asserts theme is Theme {
    if (!isTheme(theme)) {
      throw new BadRequestException(
        `Unsupported theme: ${String(theme)}. Supported values are light, dark, system.`,
      );
    }
  }

  private clientScopedPreference(theme: Theme): ThemePreference {
    return { theme, updatedAt: new Date() };
  }

  private async persistTheme(
    userId: string,
    theme: Theme,
  ): Promise<ThemePreference> {
    await this.repository.upsert({ userId, theme }, { conflictPaths: ['userId'] });

    const saved = await this.repository.findOne({ where: { userId } });
    if (!saved) {
      throw new InternalServerErrorException('Theme preference was not persisted');
    }

    return {
      theme: saved.theme,
      userId: saved.userId,
      updatedAt: saved.updatedAt,
    };
  }
}
