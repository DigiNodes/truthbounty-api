import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type Theme = 'light' | 'dark' | 'system';

export interface ThemePreference {
  theme: Theme;
  userId?: string;
  updatedAt: Date;
}

@Injectable()
export class ThemeService {
  private readonly defaultTheme: Theme = 'system';
  private readonly storageKey = 'truthbounty-theme';

  // Server-side preference store (anonymous + per-user). The frontend may
  // additionally mirror this in localStorage; the service is the source of
  // truth for the API so set-then-get round-trips are coherent.
  private anonymousTheme: Theme = this.defaultTheme;
  private readonly userThemes = new Map<string, Theme>();

  constructor(private configService: ConfigService) {}

  /**
   * Get user's theme preference
   * Priority: User preference > Default
   */
  getTheme(userId?: string): Theme {
    if (userId) {
      return this.getUserThemeFromStorage(userId);
    }

    return this.anonymousTheme;
  }

  /**
   * Set user's theme preference
   */
  setTheme(theme: Theme, userId?: string): ThemePreference {
    const preference: ThemePreference = {
      theme,
      userId,
      updatedAt: new Date(),
    };

    if (userId) {
      // Store in database for authenticated users
      this.saveUserThemeToStorage(userId, preference);
    } else {
      this.anonymousTheme = theme;
    }

    return preference;
  }

  /**
   * Get resolved theme (light/dark) based on preference
   * Resolves 'system' to actual light/dark based on system preference
   */
  getResolvedTheme(userId?: string): 'light' | 'dark' {
    const theme = this.getTheme(userId);

    if (theme === 'system') {
      // Frontend should handle system preference detection
      // Return light as default for server-side
      return 'light';
    }

    return theme;
  }

  /**
   * Toggle between light and dark themes
   * If current is 'system', defaults to 'light'
   */
  toggleTheme(userId?: string): ThemePreference {
    const currentTheme = this.getTheme(userId);
    const newTheme: Theme = currentTheme === 'light' ? 'dark' : 'light';

    return this.setTheme(newTheme, userId);
  }

  /**
   * Reset theme to system preference
   */
  resetToSystem(userId?: string): ThemePreference {
    return this.setTheme('system', userId);
  }

  /**
   * Get user theme from persistent storage (database simulation)
   */
  private getUserThemeFromStorage(userId: string): Theme {
    try {
      // In a real implementation, this would query the database
      return this.userThemes.get(userId) ?? this.defaultTheme;
    } catch {
      return this.defaultTheme;
    }
  }

  /**
   * Save user theme to persistent storage (database simulation)
   */
  private saveUserThemeToStorage(userId: string, preference: ThemePreference): void {
    try {
      // In a real implementation, this would save to database
      this.userThemes.set(userId, preference.theme);
      console.log(`Theme saved for user ${userId}: ${preference.theme}`);
    } catch (error) {
      console.warn(`Failed to save theme for user ${userId}:`, error);
    }
  }

  /**
   * Get theme statistics (for analytics)
   */
  getThemeStats(): { light: number; dark: number; system: number } {
    // In a real implementation, this would aggregate from database
    return {
      light: 0,
      dark: 0,
      system: 0,
    };
  }
}