import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FcmConfigService } from './fcm-config.service';
import * as admin from 'firebase-admin';

// Mock firebase-admin
jest.mock('firebase-admin', () => ({
  initializeApp: jest.fn(),
  messaging: jest.fn(),
  credential: {
    cert: jest.fn(),
  },
}));

describe('FcmConfigService', () => {
  let service: FcmConfigService;
  let configService: ConfigService;

  const mockConfigService = {
    get: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    
    // Reset mocks
    (admin.initializeApp as jest.Mock).mockReturnValue({} as any);
    (admin.credential.cert as jest.Mock).mockReturnValue({} as any);
  });

  describe('initialization with inline JSON', () => {
    it('should initialize with valid FCM_SERVICE_ACCOUNT_JSON', async () => {
      const serviceAccountJson = JSON.stringify({
        type: 'service_account',
        project_id: 'test-project',
        private_key: 'test-key',
        client_email: 'test@example.com',
      });

      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'FCM_SERVICE_ACCOUNT_JSON') return serviceAccountJson;
        return undefined;
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          FcmConfigService,
          {
            provide: ConfigService,
            useValue: mockConfigService,
          },
        ],
      }).compile();

      service = module.get<FcmConfigService>(FcmConfigService);

      // onModuleInit is called automatically
      expect(admin.credential.cert).toHaveBeenCalledWith({
        type: 'service_account',
        project_id: 'test-project',
        private_key: 'test-key',
        client_email: 'test@example.com',
      });
      expect(admin.initializeApp).toHaveBeenCalled();
      expect(service.isConfigured()).toBe(true);
    });

    it('should log warning when FCM is not configured', async () => {
      mockConfigService.get.mockReturnValue(undefined);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          FcmConfigService,
          {
            provide: ConfigService,
            useValue: mockConfigService,
          },
        ],
      }).compile();

      service = module.get<FcmConfigService>(FcmConfigService);

      expect(service.isConfigured()).toBe(false);
      expect(admin.initializeApp).not.toHaveBeenCalled();
    });

    it('should handle invalid JSON in FCM_SERVICE_ACCOUNT_JSON', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'FCM_SERVICE_ACCOUNT_JSON') return 'invalid-json';
        return undefined;
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          FcmConfigService,
          {
            provide: ConfigService,
            useValue: mockConfigService,
          },
        ],
      }).compile();

      service = module.get<FcmConfigService>(FcmConfigService);

      expect(service.isConfigured()).toBe(false);
      expect(service.getInitializationError()).toBeTruthy();
    });
  });

  describe('initialization with file path', () => {
    it('should initialize with valid FCM_SERVICE_ACCOUNT_PATH', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'FCM_SERVICE_ACCOUNT_PATH') return '/path/to/service-account.json';
        return undefined;
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          FcmConfigService,
          {
            provide: ConfigService,
            useValue: mockConfigService,
          },
        ],
      }).compile();

      service = module.get<FcmConfigService>(FcmConfigService);

      expect(admin.credential.cert).toHaveBeenCalledWith('/path/to/service-account.json');
      expect(admin.initializeApp).toHaveBeenCalled();
      expect(service.isConfigured()).toBe(true);
    });
  });

  describe('getMessaging', () => {
    it('should return messaging instance when configured', async () => {
      const mockMessaging = { sendEachForMulticast: jest.fn() };
      (admin.messaging as jest.Mock).mockReturnValue(mockMessaging);

      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'FCM_SERVICE_ACCOUNT_PATH') return '/path/to/service-account.json';
        return undefined;
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          FcmConfigService,
          {
            provide: ConfigService,
            useValue: mockConfigService,
          },
        ],
      }).compile();

      service = module.get<FcmConfigService>(FcmConfigService);

      const messaging = service.getMessaging();
      expect(messaging).toBe(mockMessaging);
      expect(admin.messaging).toHaveBeenCalled();
    });

    it('should return null when not configured', async () => {
      mockConfigService.get.mockReturnValue(undefined);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          FcmConfigService,
          {
            provide: ConfigService,
            useValue: mockConfigService,
          },
        ],
      }).compile();

      service = module.get<FcmConfigService>(FcmConfigService);

      expect(service.getMessaging()).toBeNull();
    });

    it('should handle errors when getting messaging instance', async () => {
      (admin.messaging as jest.Mock).mockImplementation(() => {
        throw new Error('Messaging error');
      });

      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'FCM_SERVICE_ACCOUNT_PATH') return '/path/to/service-account.json';
        return undefined;
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          FcmConfigService,
          {
            provide: ConfigService,
            useValue: mockConfigService,
          },
        ],
      }).compile();

      service = module.get<FcmConfigService>(FcmConfigService);

      expect(service.getMessaging()).toBeNull();
    });
  });

  describe('validateConfig', () => {
    beforeEach(async () => {
      mockConfigService.get.mockReturnValue(undefined);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          FcmConfigService,
          {
            provide: ConfigService,
            useValue: mockConfigService,
          },
        ],
      }).compile();

      service = module.get<FcmConfigService>(FcmConfigService);
    });

    it('should return error when FCM is not configured', () => {
      const result = service.validateConfig();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'FCM not configured: Set FCM_SERVICE_ACCOUNT_PATH or FCM_SERVICE_ACCOUNT_JSON'
      );
    });

    it('should validate JSON structure when FCM_SERVICE_ACCOUNT_JSON is provided', () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'FCM_SERVICE_ACCOUNT_JSON') {
          return JSON.stringify({
            type: 'service_account',
            project_id: 'test',
            private_key: 'key',
          });
        }
        return undefined;
      });

      // Need to reinitialize with valid JSON
      (service as any).app = {} as any; // Simulate successful initialization
      
      const result = service.validateConfig();

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should return error for invalid JSON structure', () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'FCM_SERVICE_ACCOUNT_JSON') {
          return JSON.stringify({ type: 'invalid' }); // Missing required fields
        }
        return undefined;
      });

      const result = service.validateConfig();

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'FCM_SERVICE_ACCOUNT_JSON is missing required fields'
      );
    });

    it('should return error for malformed JSON', () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'FCM_SERVICE_ACCOUNT_JSON') {
          return 'not-valid-json';
        }
        return undefined;
      });

      const result = service.validateConfig();

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('is not valid JSON');
    });
  });

  describe('isConfigured', () => {
    it('should return true when app is initialized', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'FCM_SERVICE_ACCOUNT_PATH') return '/path/to/service-account.json';
        return undefined;
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          FcmConfigService,
          {
            provide: ConfigService,
            useValue: mockConfigService,
          },
        ],
      }).compile();

      service = module.get<FcmConfigService>(FcmConfigService);

      expect(service.isConfigured()).toBe(true);
    });

    it('should return false when app is not initialized', async () => {
      mockConfigService.get.mockReturnValue(undefined);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          FcmConfigService,
          {
            provide: ConfigService,
            useValue: mockConfigService,
          },
        ],
      }).compile();

      service = module.get<FcmConfigService>(FcmConfigService);

      expect(service.isConfigured()).toBe(false);
    });
  });

  describe('getInitializationError', () => {
    it('should return null when initialization succeeds', async () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'FCM_SERVICE_ACCOUNT_PATH') return '/path/to/service-account.json';
        return undefined;
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          FcmConfigService,
          {
            provide: ConfigService,
            useValue: mockConfigService,
          },
        ],
      }).compile();

      service = module.get<FcmConfigService>(FcmConfigService);

      expect(service.getInitializationError()).toBeNull();
    });

    it('should return error when initialization fails', async () => {
      (admin.initializeApp as jest.Mock).mockImplementation(() => {
        throw new Error('Initialization failed');
      });

      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'FCM_SERVICE_ACCOUNT_PATH') return '/path/to/service-account.json';
        return undefined;
      });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          FcmConfigService,
          {
            provide: ConfigService,
            useValue: mockConfigService,
          },
        ],
      }).compile();

      service = module.get<FcmConfigService>(FcmConfigService);

      const error = service.getInitializationError();
      expect(error).toBeTruthy();
      expect(error?.message).toContain('Initialization failed');
    });
  });
});
