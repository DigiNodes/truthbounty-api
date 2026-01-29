import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { User } from '../src/entities/user.entity';
import { Wallet } from '../src/entities/wallet.entity';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';

describe('Database Connectivity (e2e)', () => {
  let app: INestApplication;
  let userRepository: Repository<User>;
  let walletRepository: Repository<Wallet>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
        }),
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: process.env.DB_HOST || 'localhost',
          port: parseInt(process.env.DB_PORT || '5432'),
          username: process.env.DB_USERNAME || 'postgres',
          password: process.env.DB_PASSWORD || 'password',
          database: process.env.DB_NAME || 'truthbounty',
          entities: [User, Wallet],
          synchronize: true, // For testing only
          dropSchema: true, // Clean slate for each test run
        }),
        TypeOrmModule.forFeature([User, Wallet]),
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    userRepository = moduleFixture.get<Repository<User>>(getRepositoryToken(User));
    walletRepository = moduleFixture.get<Repository<Wallet>>(getRepositoryToken(Wallet));
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(async () => {
    // Clean up after each test
    await walletRepository.createQueryBuilder().delete().execute();
    await userRepository.createQueryBuilder().delete().execute();
  });

  describe('PostgreSQL Connection', () => {
    it('should establish database connection', async () => {
      const count = await userRepository.count();
      expect(count).toBeDefined();
      expect(count).toBe(0);
    });
  });

  describe('User Entity CRUD', () => {
    it('should create a user', async () => {
      const user = userRepository.create({
        walletAddress: '0x1234567890123456789012345678901234567890',
        reputation: 50,
      });

      const savedUser = await userRepository.save(user);

      expect(savedUser.id).toBeDefined();
      expect(savedUser.walletAddress).toBe('0x1234567890123456789012345678901234567890');
      expect(savedUser.reputation).toBe(50);
      expect(savedUser.createdAt).toBeDefined();
      expect(savedUser.updatedAt).toBeDefined();
    });

    it('should read a user', async () => {
      const user = await userRepository.save({
        walletAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        reputation: 75,
      });

      const foundUser = await userRepository.findOne({
        where: { id: user.id },
      });

      expect(foundUser).toBeDefined();
      expect(foundUser?.walletAddress).toBe('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    });

    it('should update a user', async () => {
      const user = await userRepository.save({
        walletAddress: '0x1111111111111111111111111111111111111111',
        reputation: 30,
      });

      user.reputation = 60;
      const updatedUser = await userRepository.save(user);

      expect(updatedUser.reputation).toBe(60);
      expect(updatedUser.updatedAt.getTime()).toBeGreaterThan(updatedUser.createdAt.getTime());
    });

    it('should delete a user', async () => {
      const user = await userRepository.save({
        walletAddress: '0x2222222222222222222222222222222222222222',
        reputation: 40,
      });

      await userRepository.delete(user.id);

      const foundUser = await userRepository.findOne({
        where: { id: user.id },
      });

      expect(foundUser).toBeNull();
    });

    it('should enforce unique wallet address', async () => {
      await userRepository.save({
        walletAddress: '0x3333333333333333333333333333333333333333',
        reputation: 50,
      });

      await expect(
        userRepository.save({
          walletAddress: '0x3333333333333333333333333333333333333333',
          reputation: 60,
        }),
      ).rejects.toThrow();
    });
  });

  describe('Wallet Entity CRUD', () => {
    let testUser: User;

    beforeEach(async () => {
      testUser = await userRepository.save({
        walletAddress: '0x4444444444444444444444444444444444444444',
        reputation: 70,
      });
    });

    it('should create a wallet', async () => {
      const wallet = walletRepository.create({
        address: '0x4444444444444444444444444444444444444444',
        chain: 'ethereum',
        userId: testUser.id,
      });

      const savedWallet = await walletRepository.save(wallet);

      expect(savedWallet.id).toBeDefined();
      expect(savedWallet.address).toBe('0x4444444444444444444444444444444444444444');
      expect(savedWallet.chain).toBe('ethereum');
      expect(savedWallet.userId).toBe(testUser.id);
      expect(savedWallet.linkedAt).toBeDefined();
    });

    it('should allow same address on different chains', async () => {
      await walletRepository.save({
        address: '0x5555555555555555555555555555555555555555',
        chain: 'ethereum',
        userId: testUser.id,
      });

      const wallet2 = await walletRepository.save({
        address: '0x5555555555555555555555555555555555555555',
        chain: 'optimism',
        userId: testUser.id,
      });

      expect(wallet2.id).toBeDefined();
    });

    it('should enforce unique (address, chain) constraint', async () => {
      await walletRepository.save({
        address: '0x6666666666666666666666666666666666666666',
        chain: 'ethereum',
        userId: testUser.id,
      });

      await expect(
        walletRepository.save({
          address: '0x6666666666666666666666666666666666666666',
          chain: 'ethereum',
          userId: testUser.id,
        }),
      ).rejects.toThrow();
    });
  });

  describe('User-Wallet Relationship', () => {
    it('should load wallets with user', async () => {
      const user = await userRepository.save({
        walletAddress: '0x7777777777777777777777777777777777777777',
        reputation: 80,
      });

      await walletRepository.save([
        {
          address: '0x7777777777777777777777777777777777777777',
          chain: 'ethereum',
          userId: user.id,
        },
        {
          address: '0x7777777777777777777777777777777777777777',
          chain: 'optimism',
          userId: user.id,
        },
      ]);

      const userWithWallets = await userRepository.findOne({
        where: { id: user.id },
        relations: ['wallets'],
      });

      expect(userWithWallets?.wallets).toHaveLength(2);
    });

    it('should cascade delete wallets when user is deleted', async () => {
      const user = await userRepository.save({
        walletAddress: '0x8888888888888888888888888888888888888888',
        reputation: 90,
      });

      await walletRepository.save({
        address: '0x8888888888888888888888888888888888888888',
        chain: 'ethereum',
        userId: user.id,
      });

      await userRepository.delete(user.id);

      const wallets = await walletRepository.find({
        where: { userId: user.id },
      });

      expect(wallets).toHaveLength(0);
    });
  });
});
