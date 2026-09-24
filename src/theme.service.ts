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

  constructor(private configService: ConfigService) {}

  /**
   * Get user's theme preference
   * Priority: User preference > Default
   */
  getTheme(userId?: string): Theme {
    // If user ID provided, get from database (future enhancement)
    if (userId) {
      return this.getUserThemeFromStorage(userId);
    }

    // For anonymous users, return default theme
    // Frontend should handle localStorage persistence
    return this.defaultTheme;
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
    }
    // For anonymous users, frontend should handle localStorage

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
      // For now, return default
      return this.defaultTheme;
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