import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ThemeService } from './theme.service';
import { UserThemePreference } from './theme.entity';

describe('ThemeService', () => {
  let service: ThemeService;
  let repository: {
    findOne: jest.Mock;
    upsert: jest.Mock;
    query: jest.Mock;
    count: jest.Mock;
  };

  const updatedAt = new Date('2026-11-24T10:00:00.000Z');

  beforeEach(async () => {
    repository = {
      findOne: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      query: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ThemeService,
        {
          provide: getRepositoryToken(UserThemePreference),
          useValue: repository,
        },
      ],
    }).compile();

    service = module.get<ThemeService>(ThemeService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getTheme', () => {
    it('returns the system default for anonymous callers without database access', async () => {
      await expect(service.getTheme()).resolves.toBe('system');
      expect(repository.findOne).not.toHaveBeenCalled();
    });

    it('returns the system default when an authenticated user has no stored preference', async () => {
      await expect(service.getTheme('user-123')).resolves.toBe('system');
      expect(repository.findOne).toHaveBeenCalledWith({
        where: { userId: 'user-123' },
      });
    });

    it('returns the owner-scoped persisted preference', async () => {
      repository.findOne.mockResolvedValue({
        theme: 'dark',
        userId: 'user-123',
        updatedAt,
      });

      await expect(service.getTheme('user-123')).resolves.toBe('dark');
    });
  });

  describe('setTheme', () => {
    it('rejects unsupported theme values before writing', async () => {
      await expect(
        service.setTheme('neon' as never, 'user-123'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.upsert).not.toHaveBeenCalled();
    });

    it('persists an authenticated preference with an owner-scoped upsert', async () => {
      repository.findOne.mockResolvedValue({
        theme: 'light',
        userId: 'user-123',
        updatedAt,
      });

      const result = await service.setTheme('light', 'user-123');

      expect(repository.upsert).toHaveBeenCalledWith(
        { userId: 'user-123', theme: 'light' },
        { conflictPaths: ['userId'] },
      );
      expect(result).toEqual({
        theme: 'light',
        userId: 'user-123',
        updatedAt,
      });
    });

    it('keeps anonymous preferences client-scoped without creating server state', async () => {
      const result = await service.setTheme('dark');

      expect(result.theme).toBe('dark');
      expect(result.userId).toBeUndefined();
      expect(result.updatedAt).toBeInstanceOf(Date);
      expect(repository.upsert).not.toHaveBeenCalled();
      await expect(service.getTheme()).resolves.toBe('system');
    });
  });

  describe('getResolvedTheme', () => {
    it('resolves system to light', async () => {
      await expect(service.getResolvedTheme()).resolves.toBe('light');
    });

    it('returns the persisted explicit theme', async () => {
      repository.findOne.mockResolvedValue({
        theme: 'dark',
        userId: 'user-123',
        updatedAt,
      });

      await expect(service.getResolvedTheme('user-123')).resolves.toBe('dark');
    });
  });

  describe('toggleTheme', () => {
    it('toggles the authenticated owner persisted preference atomically', async () => {
      repository.query.mockResolvedValue([
        { theme: 'dark', userId: 'user-123', updatedAt },
      ]);

      const result = await service.toggleTheme('user-123');

      expect(result).toEqual({
        theme: 'dark',
        userId: 'user-123',
        updatedAt,
      });
      expect(repository.query).toHaveBeenCalledTimes(1);
      expect(repository.query.mock.calls[0][0]).toContain(
        'ON CONFLICT ("userId") DO UPDATE',
      );
      expect(repository.query.mock.calls[0][1]).toEqual(['user-123', 'light']);
      expect(repository.findOne).not.toHaveBeenCalled();
      expect(repository.upsert).not.toHaveBeenCalled();
    });

    it('uses only the caller-provided theme for anonymous toggles', async () => {
      const result = await service.toggleTheme(undefined, 'dark');

      expect(result.theme).toBe('light');
      expect(result.userId).toBeUndefined();
      expect(repository.upsert).not.toHaveBeenCalled();
      expect(repository.findOne).not.toHaveBeenCalled();
    });
  });

  describe('resetToSystem', () => {
    it('persists the system preference for an authenticated owner', async () => {
      repository.findOne.mockResolvedValue({
        theme: 'system',
        userId: 'user-123',
        updatedAt,
      });

      const result = await service.resetToSystem('user-123');

      expect(result.theme).toBe('system');
      expect(repository.upsert).toHaveBeenCalledWith(
        { userId: 'user-123', theme: 'system' },
        { conflictPaths: ['userId'] },
      );
    });
  });

  describe('getThemeStats', () => {
    it('counts persisted records only', async () => {
      repository.count.mockImplementation(
        ({ where }: { where: { theme: string } }) =>
          Promise.resolve({ light: 2, dark: 3, system: 1 }[where.theme] ?? 0),
      );

      await expect(service.getThemeStats()).resolves.toEqual({
        light: 2,
        dark: 3,
        system: 1,
      });
      expect(repository.count).toHaveBeenCalledTimes(3);
    });
  });

  describe('concurrent owner-scoped updates', () => {
    it('never mixes preferences between users', async () => {
      repository.findOne.mockImplementation(
        ({ where }: { where: { userId: string } }) =>
          Promise.resolve({
            theme: where.userId === 'user-a' ? 'dark' : 'light',
            userId: where.userId,
            updatedAt,
          }),
      );

      await Promise.all([
        service.setTheme('dark', 'user-a'),
        service.setTheme('light', 'user-b'),
      ]);

      expect(repository.upsert).toHaveBeenCalledWith(
        { userId: 'user-a', theme: 'dark' },
        { conflictPaths: ['userId'] },
      );
      expect(repository.upsert).toHaveBeenCalledWith(
        { userId: 'user-b', theme: 'light' },
        { conflictPaths: ['userId'] },
      );
    });
  });
});
