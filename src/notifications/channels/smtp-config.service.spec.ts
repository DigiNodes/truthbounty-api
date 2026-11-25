import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SmtpConfigService } from './smtp-config.service';

describe('SmtpConfigService', () => {
  let service: SmtpConfigService;
  let configService: ConfigService;

  const mockConfigService = {
    get: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmtpConfigService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
      ],
    }).compile();

    service = module.get<SmtpConfigService>(SmtpConfigService);
    configService = module.get<ConfigService>(ConfigService);
  });

  describe('validateConfig', () => {
    it('should return valid config when all required fields are present', () => {
      mockConfigService.get.mockImplementation((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          SMTP_HOST: 'smtp.example.com',
          SMTP_PORT: 587,
          SMTP_USER: 'user@example.com',
          SMTP_PASSWORD: 'secret',
          SMTP_FROM: 'notifications@truthbounty.io',
          SMTP_SECURE: false,
          SMTP_FROM_NAME: 'TruthBounty',
          SMTP_CONNECTION_TIMEOUT: 10000,
          SMTP_GREETINGS_TIMEOUT: 5000,
        };
        return config[key] ?? defaultValue;
      });

      const result = service.validateConfig();

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.config).toEqual({
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        auth: {
          user: 'user@example.com',
          pass: 'secret',
        },
        from: {
          name: 'TruthBounty',
          address: 'notifications@truthbounty.io',
        },
        connectionTimeout: 10000,
        greetingsTimeout: 5000,
      });
    });

    it('should return error when SMTP_HOST is missing', () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'SMTP_HOST') return undefined;
        return 'value';
      });

      const result = service.validateConfig();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('SMTP_HOST is required');
    });

    it('should return error when SMTP_PORT is missing', () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'SMTP_PORT') return undefined;
        return 'value';
      });

      const result = service.validateConfig();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('SMTP_PORT is required');
    });

    it('should return error when SMTP_PORT is invalid', () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'SMTP_PORT') return 70000; // Invalid port
        return 'value';
      });

      const result = service.validateConfig();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('SMTP_PORT must be between 1 and 65535');
    });

    it('should return error when SMTP_USER is missing', () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'SMTP_USER') return undefined;
        if (key === 'SMTP_PORT') return 587;
        return 'value';
      });

      const result = service.validateConfig();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('SMTP_USER is required');
    });

    it('should return error when SMTP_PASSWORD is missing', () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'SMTP_PASSWORD') return undefined;
        if (key === 'SMTP_PASS') return undefined;
        if (key === 'SMTP_PORT') return 587;
        return 'value';
      });

      const result = service.validateConfig();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('SMTP_PASSWORD (or SMTP_PASS) is required');
    });

    it('should accept SMTP_PASS as alternative to SMTP_PASSWORD', () => {
      mockConfigService.get.mockImplementation((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          SMTP_HOST: 'smtp.example.com',
          SMTP_PORT: 587,
          SMTP_USER: 'user@example.com',
          SMTP_PASS: 'secret', // Using SMTP_PASS instead of SMTP_PASSWORD
          SMTP_FROM: 'notifications@truthbounty.io',
        };
        return config[key] ?? defaultValue;
      });

      const result = service.validateConfig();

      expect(result.valid).toBe(true);
      expect(result.config?.auth.pass).toBe('secret');
    });

    it('should return error when SMTP_FROM is missing', () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'SMTP_FROM') return undefined;
        if (key === 'NOTIFICATION_EMAIL_FROM') return undefined;
        if (key === 'SMTP_PORT') return 587;
        return 'value';
      });

      const result = service.validateConfig();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('SMTP_FROM (or NOTIFICATION_EMAIL_FROM) is required');
    });

    it('should use default values for optional fields', () => {
      mockConfigService.get.mockImplementation((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          SMTP_HOST: 'smtp.example.com',
          SMTP_PORT: 587,
          SMTP_USER: 'user@example.com',
          SMTP_PASSWORD: 'secret',
          SMTP_FROM: 'notifications@truthbounty.io',
        };
        return config[key] ?? defaultValue;
      });

      const result = service.validateConfig();

      expect(result.valid).toBe(true);
      expect(result.config?.secure).toBe(false); // Default
      expect(result.config?.from.name).toBe('TruthBounty'); // Default
      expect(result.config?.connectionTimeout).toBe(10000); // Default
      expect(result.config?.greetingsTimeout).toBe(5000); // Default
    });

    it('should cache config after first validation', () => {
      mockConfigService.get.mockImplementation((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          SMTP_HOST: 'smtp.example.com',
          SMTP_PORT: 587,
          SMTP_USER: 'user@example.com',
          SMTP_PASSWORD: 'secret',
          SMTP_FROM: 'notifications@truthbounty.io',
        };
        return config[key] ?? defaultValue;
      });

      // First call
      const result1 = service.validateConfig();
      expect(result1.valid).toBe(true);

      // Clear mock to verify caching
      mockConfigService.get.mockClear();

      // Second call should use cache
      const result2 = service.getConfig();
      expect(result2).toEqual(result1.config);
      expect(mockConfigService.get).not.toHaveBeenCalled(); // Not called due to cache
    });
  });

  describe('isConfigured', () => {
    it('should return true when configuration is valid', () => {
      mockConfigService.get.mockImplementation((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          SMTP_HOST: 'smtp.example.com',
          SMTP_PORT: 587,
          SMTP_USER: 'user@example.com',
          SMTP_PASSWORD: 'secret',
          SMTP_FROM: 'notifications@truthbounty.io',
        };
        return config[key] ?? defaultValue;
      });

      expect(service.isConfigured()).toBe(true);
    });

    it('should return false when configuration is invalid', () => {
      mockConfigService.get.mockImplementation((key: string) => {
        // Missing SMTP_HOST
        if (key === 'SMTP_HOST') return undefined;
        return 'value';
      });

      expect(service.isConfigured()).toBe(false);
    });
  });

  describe('getConfig', () => {
    it('should return null when configuration is invalid', () => {
      mockConfigService.get.mockImplementation((key: string) => {
        // Missing SMTP_HOST
        if (key === 'SMTP_HOST') return undefined;
        return 'value';
      });

      expect(service.getConfig()).toBeNull();
    });

    it('should return config when valid', () => {
      mockConfigService.get.mockImplementation((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          SMTP_HOST: 'smtp.example.com',
          SMTP_PORT: 587,
          SMTP_USER: 'user@example.com',
          SMTP_PASSWORD: 'secret',
          SMTP_FROM: 'notifications@truthbounty.io',
        };
        return config[key] ?? defaultValue;
      });

      const config = service.getConfig();
      expect(config).not.toBeNull();
      expect(config?.host).toBe('smtp.example.com');
    });
  });

  describe('getErrors', () => {
    it('should return validation errors after failed validation', () => {
      mockConfigService.get.mockImplementation((key: string) => {
        // Missing multiple required fields
        if (key === 'SMTP_HOST') return undefined;
        if (key === 'SMTP_USER') return undefined;
        if (key === 'SMTP_PORT') return 587;
        return 'value';
      });

      service.validateConfig();
      const errors = service.getErrors();

      expect(errors).toContain('SMTP_HOST is required');
      expect(errors).toContain('SMTP_USER is required');
      expect(errors.length).toBeGreaterThan(0);
    });

    it('should return empty array after successful validation', () => {
      mockConfigService.get.mockImplementation((key: string, defaultValue?: any) => {
        const config: Record<string, any> = {
          SMTP_HOST: 'smtp.example.com',
          SMTP_PORT: 587,
          SMTP_USER: 'user@example.com',
          SMTP_PASSWORD: 'secret',
          SMTP_FROM: 'notifications@truthbounty.io',
        };
        return config[key] ?? defaultValue;
      });

      service.validateConfig();
      const errors = service.getErrors();

      expect(errors).toEqual([]);
    });
  });
});
