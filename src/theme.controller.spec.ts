import { ThemeController } from './theme.controller';
import { ThemeService } from './theme.service';

describe('ThemeController', () => {
  let controller: ThemeController;
  let service: {
    getTheme: jest.Mock;
    setTheme: jest.Mock;
    getResolvedTheme: jest.Mock;
    toggleTheme: jest.Mock;
    resetToSystem: jest.Mock;
    getThemeStats: jest.Mock;
  };

  const principal = {
    userId: 'owner-1',
    user: { id: 'owner-1' },
    address: '0x0000000000000000000000000000000000000001',
  };

  beforeEach(() => {
    service = {
      getTheme: jest.fn().mockResolvedValue('dark'),
      setTheme: jest.fn().mockResolvedValue({ theme: 'dark', updatedAt: new Date() }),
      getResolvedTheme: jest.fn().mockResolvedValue('dark'),
      toggleTheme: jest.fn().mockResolvedValue({ theme: 'light', updatedAt: new Date() }),
      resetToSystem: jest.fn().mockResolvedValue({ theme: 'system', updatedAt: new Date() }),
      getThemeStats: jest.fn().mockResolvedValue({ light: 1, dark: 2, system: 3 }),
    };
    controller = new ThemeController(service as unknown as ThemeService);
  });

  it('reads the theme for the authenticated principal', async () => {
    await expect(controller.getTheme(principal)).resolves.toEqual({
      theme: 'dark',
      resolved: 'dark',
    });
    expect(service.getTheme).toHaveBeenCalledWith('owner-1');
    expect(service.getResolvedTheme).toHaveBeenCalledWith('owner-1');
  });

  it('returns the default for anonymous reads', async () => {
    await controller.getTheme(undefined);
    expect(service.getTheme).toHaveBeenCalledWith(undefined);
  });

  it('ignores client-supplied user identifiers on writes', async () => {
    await controller.setTheme(principal, { theme: 'dark' });

    expect(service.setTheme).toHaveBeenCalledWith('dark', 'owner-1');
  });

  it('passes only the client-scoped theme through anonymous toggles', async () => {
    await controller.toggleTheme(undefined, { currentTheme: 'dark' });

    expect(service.toggleTheme).toHaveBeenCalledWith(undefined, 'dark');
  });

  it('resets only the authenticated owner preference', async () => {
    await controller.resetToSystem(principal);

    expect(service.resetToSystem).toHaveBeenCalledWith('owner-1');
  });

  it('returns persisted statistics', async () => {
    await expect(controller.getThemeStats()).resolves.toEqual({
      light: 1,
      dark: 2,
      system: 3,
    });
  });
});
