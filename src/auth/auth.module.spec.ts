import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthModule } from './auth.module';
import { JwtStrategy } from './strategies/jwt.strategy';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * AuthModule Bootstrap & Integration Tests
 * 
 * Purpose: Verify that AuthModule can compile, bootstrap, and properly
 * instantiate JwtStrategy with correct NestJS and Passport imports.
 * 
 * This test ensures that:
 * 1. The module compiles without import errors
 * 2. JwtStrategy can be instantiated with correct dependencies
 * 3. Passport integration works correctly
 */
describe('AuthModule - Bootstrap & Integration', () => {
  let module: TestingModule;
  let jwtStrategy: JwtStrategy;
  let authService: AuthService;

  beforeEach(async () => {
    // Mock PrismaService to avoid database connection
    const mockPrismaService = {
      user: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      nonce: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      session: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      authAttempt: {
        create: jest.fn(),
        findMany: jest.fn(),
      },
      $transaction: jest.fn((callback) => callback(mockPrismaService)),
    };

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: '.env.test',
        }),
        PassportModule.register({ defaultStrategy: 'jwt' }),
        JwtModule.register({
          secret: 'test-secret-key',
          signOptions: { expiresIn: '15m' },
        }),
      ],
      providers: [
        AuthService,
        JwtStrategy,
        {
          provide: PrismaService,
          useValue: mockPrismaService,
        },
      ],
    }).compile();

    jwtStrategy = module.get<JwtStrategy>(JwtStrategy);
    authService = module.get<AuthService>(AuthService);
  });

  afterEach(async () => {
    if (module) {
      await module.close();
    }
  });

  describe('Module Compilation & Bootstrap', () => {
    it('should compile the module successfully', () => {
      expect(module).toBeDefined();
    });

    it('should instantiate JwtStrategy from NestJS imports', () => {
      expect(jwtStrategy).toBeDefined();
      expect(jwtStrategy).toBeInstanceOf(JwtStrategy);
    });

    it('should instantiate AuthService', () => {
      expect(authService).toBeDefined();
      expect(authService).toBeInstanceOf(AuthService);
    });

    it('should have JwtStrategy with validate method', () => {
      expect(jwtStrategy.validate).toBeDefined();
      expect(typeof jwtStrategy.validate).toBe('function');
    });
  });

  describe('Passport Strategy Registration', () => {
    it('should register JwtStrategy as a Passport strategy', () => {
      // Verify that JwtStrategy extends PassportStrategy correctly
      // by checking it has the necessary Passport integration
      expect(jwtStrategy).toBeDefined();
      
      // The strategy should have inherited methods from PassportStrategy
      expect(jwtStrategy.validate).toBeDefined();
    });

    it('should be retrievable from the module container', () => {
      const retrievedStrategy = module.get<JwtStrategy>(JwtStrategy);
      expect(retrievedStrategy).toBe(jwtStrategy);
    });
  });

  describe('Dependency Injection', () => {
    it('should inject AuthService into JwtStrategy', () => {
      // Access private property for testing purposes
      const strategyAuthService = (jwtStrategy as any).authService;
      expect(strategyAuthService).toBeDefined();
      expect(strategyAuthService).toBe(authService);
    });

    it('should inject ConfigService into JwtStrategy', () => {
      const strategyConfigService = (jwtStrategy as any).configService;
      expect(strategyConfigService).toBeDefined();
    });
  });

  describe('Import Resolution Verification', () => {
    it('should successfully import Injectable from @nestjs/common', () => {
      // The fact that JwtStrategy can be instantiated proves
      // @Injectable() decorator from @nestjs/common works
      expect(jwtStrategy).toBeInstanceOf(JwtStrategy);
    });

    it('should successfully import PassportStrategy from @nestjs/passport', () => {
      // The fact that JwtStrategy can extend PassportStrategy proves
      // the import from @nestjs/passport is correct
      expect(jwtStrategy.validate).toBeDefined();
    });

    it('should have correct constructor signature', () => {
      // Verify the constructor was called with correct dependencies
      const strategyAuthService = (jwtStrategy as any).authService;
      const strategyConfigService = (jwtStrategy as any).configService;
      
      expect(strategyAuthService).toBeDefined();
      expect(strategyConfigService).toBeDefined();
    });
  });
});

describe('AuthModule - Full Module Import Test', () => {
  let module: TestingModule;

  beforeEach(async () => {
    // Mock PrismaService
    const mockPrismaService = {
      user: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
      nonce: { findUnique: jest.fn(), create: jest.fn(), delete: jest.fn() },
      session: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
      authAttempt: { create: jest.fn(), findMany: jest.fn() },
      $transaction: jest.fn(),
    };

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        AuthModule,
      ],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrismaService)
      .compile();
  });

  afterEach(async () => {
    if (module) {
      await module.close();
    }
  });

  it('should compile AuthModule with all providers', () => {
    expect(module).toBeDefined();
  });

  it('should provide JwtStrategy', () => {
    const jwtStrategy = module.get<JwtStrategy>(JwtStrategy);
    expect(jwtStrategy).toBeDefined();
  });

  it('should provide AuthService', () => {
    const authService = module.get<AuthService>(AuthService);
    expect(authService).toBeDefined();
  });
});
