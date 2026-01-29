import { DataSource } from 'typeorm';
import { config } from 'dotenv';
import { User } from '../entities/user.entity';
import { Wallet } from '../entities/wallet.entity';

// Load environment variables
config();

/**
 * Seed Script for TruthBounty API
 * 
 * Creates sample data for local development:
 * - Test users with varying reputation levels
 * - Multiple wallets per user across different chains
 * 
 * Usage: npm run seed
 */

const dataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  username: process.env.DB_USERNAME || 'postgres',
  password: process.env.DB_PASSWORD || 'password',
  database: process.env.DB_NAME || 'truthbounty',
  entities: [User, Wallet],
  synchronize: false,
});

async function seed() {
  console.log('🌱 Starting database seed...');

  try {
    await dataSource.initialize();
    console.log('✅ Database connection established');

    const userRepository = dataSource.getRepository(User);
    const walletRepository = dataSource.getRepository(Wallet);

    // Clear existing data (optional - comment out if you want to preserve data)
    // Note: Commented out for first run since database is empty
    // console.log('🗑️  Clearing existing seed data...');
    // await walletRepository.clear();
    // await userRepository.clear();

    // Create test users
    console.log('👥 Creating test users...');

    const user1 = userRepository.create({
      walletAddress: '0x1234567890123456789012345678901234567890',
      reputation: 85,
    });
    await userRepository.save(user1);

    const user2 = userRepository.create({
      walletAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      reputation: 60,
    });
    await userRepository.save(user2);

    const user3 = userRepository.create({
      walletAddress: '0x9876543210987654321098765432109876543210',
      reputation: 30,
    });
    await userRepository.save(user3);

    const user4 = userRepository.create({
      walletAddress: '0x1111222233334444555566667777888899990000',
      reputation: 95,
    });
    await userRepository.save(user4);

    const user5 = userRepository.create({
      walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      reputation: 10,
    });
    await userRepository.save(user5);

    console.log(`✅ Created ${await userRepository.count()} users`);

    // Create wallets for users
    console.log('💼 Creating wallets...');

    // User 1 - Multiple wallets
    await walletRepository.save([
      {
        address: '0x1234567890123456789012345678901234567890',
        chain: 'ethereum',
        userId: user1.id,
      },
      {
        address: '0x1234567890123456789012345678901234567890',
        chain: 'optimism',
        userId: user1.id,
      },
      {
        address: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        chain: 'stellar',
        userId: user1.id,
      },
    ]);

    // User 2 - Single wallet
    await walletRepository.save({
      address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      chain: 'ethereum',
      userId: user2.id,
    });

    // User 3 - Multiple chains
    await walletRepository.save([
      {
        address: '0x9876543210987654321098765432109876543210',
        chain: 'ethereum',
        userId: user3.id,
      },
      {
        address: '0x9876543210987654321098765432109876543210',
        chain: 'polygon',
        userId: user3.id,
      },
    ]);

    // User 4 - Optimism only
    await walletRepository.save({
      address: '0x1111222233334444555566667777888899990000',
      chain: 'optimism',
      userId: user4.id,
    });

    // User 5 - Ethereum only
    await walletRepository.save({
      address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      chain: 'ethereum',
      userId: user5.id,
    });

    console.log(`✅ Created ${await walletRepository.count()} wallets`);

    console.log('\n🎉 Seed completed successfully!');
    console.log('\n📊 Summary:');
    console.log(`   Users: ${await userRepository.count()}`);
    console.log(`   Wallets: ${await walletRepository.count()}`);
    console.log('\n💡 Sample users:');
    console.log('   User 1: High reputation (85) - Multi-chain');
    console.log('   User 2: Medium reputation (60) - Ethereum only');
    console.log('   User 3: Low reputation (30) - Ethereum + Polygon');
    console.log('   User 4: Very high reputation (95) - Optimism only');
    console.log('   User 5: New user (10) - Ethereum only');

  } catch (error) {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  } finally {
    await dataSource.destroy();
    console.log('\n👋 Database connection closed');
  }
}

// Run the seed
seed();
