import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ThemeService } from './theme.service';

describe('ThemeService', () => {
  let service: ThemeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThemeService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ThemeService>(ThemeService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getTheme', () => {
    it('should return default theme when no userId provided', () => {
      const theme = service.getTheme();
      expect(theme).toBe('system');
    });

    it('should return default theme for user without stored preference', () => {
      const theme = service.getTheme('user-123');
      expect(theme).toBe('system');
    });
  });

  describe('setTheme', () => {
    it('should set theme for anonymous user', () => {
      const result = service.setTheme('dark');
      expect(result.theme).toBe('dark');
      expect(result.userId).toBeUndefined();
      expect(result.updatedAt).toBeInstanceOf(Date);
    });

    it('should set theme for authenticated user', () => {
      const result = service.setTheme('light', 'user-123');
      expect(result.theme).toBe('light');
      expect(result.userId).toBe('user-123');
      expect(result.updatedAt).toBeInstanceOf(Date);
    });
  });

  describe('getResolvedTheme', () => {
    it('should resolve system theme to light (server default)', () => {
      service.setTheme('system');
      const resolved = service.getResolvedTheme();
      expect(resolved).toBe('light');
    });

    it('should return set theme when not system', () => {
      service.setTheme('dark');
      const resolved = service.getResolvedTheme();
      expect(resolved).toBe('dark');
    });
  });

  describe('toggleTheme', () => {
    it('should toggle from light to dark', () => {
      service.setTheme('light');
      const result = service.toggleTheme();
      expect(result.theme).toBe('dark');
    });

    it('should toggle from dark to light', () => {
      service.setTheme('dark');
      const result = service.toggleTheme();
      expect(result.theme).toBe('light');
    });

    it('should toggle from system to light', () => {
      service.setTheme('system');
      const result = service.toggleTheme();
      expect(result.theme).toBe('light');
    });
  });

  describe('resetToSystem', () => {
    it('should reset theme to system', () => {
      service.setTheme('dark');
      const result = service.resetToSystem();
      expect(result.theme).toBe('system');
    });
  });

  describe('getThemeStats', () => {
    it('should return theme statistics', () => {
      const stats = service.getThemeStats();
      expect(stats).toHaveProperty('light');
      expect(stats).toHaveProperty('dark');
      expect(stats).toHaveProperty('system');
      expect(typeof stats.light).toBe('number');
      expect(typeof stats.dark).toBe('number');
      expect(typeof stats.system).toBe('number');
    });
  });
});