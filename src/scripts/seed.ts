import { DataSource } from 'typeorm';
import { config } from 'dotenv';
import { User } from '../entities/user.entity';
import { Wallet } from '../entities/wallet.entity';
import { Claim } from '../claims/entities/claim.entity';
import { Evidence } from '../claims/entities/evidence.entity';
import { EvidenceVersion } from '../claims/entities/evidence-version.entity';

// Load environment variables
config();

/**
 * Seed Script for TruthBounty API
 *
 * Creates sample data for local development and testing:
 * - Test users with varying reputation levels
 * - Multiple wallets per user across different chains
 * - Sample claims with various resolution states
 * - Supporting evidence with version history
 *
 * Usage: npm run seed
 */

const dataSource = new DataSource({
  type: 'better-sqlite3',
  database: process.env.DATABASE_PATH || 'database.sqlite',
  entities: [User, Wallet, Claim, Evidence, EvidenceVersion],
  synchronize: true, // Enable for seeding to create tables if needed
  logging: false,
});

async function seed() {
  console.log('🌱 Starting database seed...');

  try {
    await dataSource.initialize();
    console.log('✅ Database connection established');

    const userRepository = dataSource.getRepository(User);
    const walletRepository = dataSource.getRepository(Wallet);
    const claimRepository = dataSource.getRepository(Claim);
    const evidenceRepository = dataSource.getRepository(Evidence);
    const evidenceVersionRepository = dataSource.getRepository(EvidenceVersion);

    // Option to clear existing data (disabled by default for safety)
    const shouldClear = process.argv.includes('--clear');
    if (shouldClear) {
      console.log('🗑️  Clearing existing seed data...');
      await evidenceVersionRepository.delete({});
      await evidenceRepository.delete({});
      await claimRepository.delete({});
      await walletRepository.delete({});
      await userRepository.delete({});
    }

    // ========================================
    // SECTION 1: CREATE TEST USERS
    // ========================================
    console.log('\n👥 Creating test users...');

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

    // ========================================
    // SECTION 2: CREATE WALLETS
    // ========================================
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

    // ========================================
    // SECTION 3: CREATE SAMPLE CLAIMS
    // ========================================
    console.log('\n📋 Creating sample claims...');

    // Claim 1: Resolved as TRUE with high confidence
    const claim1 = claimRepository.create({
      resolvedVerdict: true,
      confidenceScore: 0.95,
      finalized: true,
    });
    await claimRepository.save(claim1);

    // Claim 2: Resolved as FALSE with moderate confidence
    const claim2 = claimRepository.create({
      resolvedVerdict: false,
      confidenceScore: 0.72,
      finalized: true,
    });
    await claimRepository.save(claim2);

    // Claim 3: Unresolved (neutral verdict) with moderate confidence
    const claim3 = claimRepository.create({
      resolvedVerdict: null,
      confidenceScore: 0.58,
      finalized: false,
    });
    await claimRepository.save(claim3);

    // Claim 4: Resolved as TRUE with high confidence
    const claim4 = claimRepository.create({
      resolvedVerdict: true,
      confidenceScore: 0.88,
      finalized: true,
    });
    await claimRepository.save(claim4);

    // Claim 5: Recently created, not yet finalized
    const claim5 = claimRepository.create({
      resolvedVerdict: null,
      confidenceScore: null,
      finalized: false,
    });
    await claimRepository.save(claim5);

    console.log(`✅ Created ${await claimRepository.count()} claims`);

    // ========================================
    // SECTION 4: CREATE SUPPORTING EVIDENCE
    // ========================================
    console.log('\n📄 Creating supporting evidence...');

    // Evidence for Claim 1
    const evidence1 = evidenceRepository.create({
      claimId: claim1.id,
      latestVersion: 2,
    });
    await evidenceRepository.save(evidence1);

    // Evidence versions for Claim 1 (simulating revision history)
    await evidenceVersionRepository.save([
      {
        evidenceId: evidence1.id,
        version: 1,
        cid: 'QmV8cfu5z63jHckaj6mWBZWe73eV5mUDzRvDxFnX72Ujr',
      },
      {
        evidenceId: evidence1.id,
        version: 2,
        cid: 'QmWKHBNaZgPLQAFVHp3r5L8kY8n9t2e4vCxF5bG3hD8jP',
      },
    ]);

    // Evidence for Claim 2
    const evidence2 = evidenceRepository.create({
      claimId: claim2.id,
      latestVersion: 1,
    });
    await evidenceRepository.save(evidence2);

    await evidenceVersionRepository.save({
      evidenceId: evidence2.id,
      version: 1,
      cid: 'QmX9dGu5a3hL5mK7pN2r8T4vF6wX3yZ8q9s0dE1fG2hJ9',
    });

    // Multiple evidence for Claim 3
    const evidence3a = evidenceRepository.create({
      claimId: claim3.id,
      latestVersion: 1,
    });
    await evidenceRepository.save(evidence3a);

    const evidence3b = evidenceRepository.create({
      claimId: claim3.id,
      latestVersion: 1,
    });
    await evidenceRepository.save(evidence3b);

    await evidenceVersionRepository.save([
      {
        evidenceId: evidence3a.id,
        version: 1,
        cid: 'QmY5eH2kM8pO1rL3sT9vA0w1bF4cG5mN7oP8qR9sT2uV',
      },
      {
        evidenceId: evidence3b.id,
        version: 1,
        cid: 'QmZ6fI3lN9qP2sM4tU0wB1x2cG6nO8pQ9rS0tU3vW5xY',
      },
    ]);

    // Evidence for Claim 4
    const evidence4 = evidenceRepository.create({
      claimId: claim4.id,
      latestVersion: 3,
    });
    await evidenceRepository.save(evidence4);

    await evidenceVersionRepository.save([
      {
        evidenceId: evidence4.id,
        version: 1,
        cid: 'QmA1bJ2cK3dL4eM5fN6gO7hP8iQ9jR0kS1lT2mU3nV4oW',
      },
      {
        evidenceId: evidence4.id,
        version: 2,
        cid: 'QmB2cK3dL4eM5fN6gO7hP8iQ9jR0kS1lT2mU3nV4oW5xX',
      },
      {
        evidenceId: evidence4.id,
        version: 3,
        cid: 'QmC3dL4eM5fN6gO7hP8iQ9jR0kS1lT2mU3nV4oW5xX6yY',
      },
    ]);

    console.log(
      `✅ Created ${await evidenceRepository.count()} evidence entries`,
    );
    console.log(
      `✅ Created ${await evidenceVersionRepository.count()} evidence versions`,
    );

    // ========================================
    // SUMMARY & STATISTICS
    // ========================================
    console.log('\n🎉 Seed completed successfully!');
    console.log('\n📊 Database Summary:');
    console.log(`   Users: ${await userRepository.count()}`);
    console.log(`   Wallets: ${await walletRepository.count()}`);
    console.log(`   Claims: ${await claimRepository.count()}`);
    console.log(`   Evidence: ${await evidenceRepository.count()}`);
    console.log(
      `   Evidence Versions: ${await evidenceVersionRepository.count()}`,
    );

    console.log('\n📋 Sample Data Created:');
    console.log('\n   Users:');
    console.log('   - User 1: High reputation (85) - Multi-chain');
    console.log('   - User 2: Medium reputation (60) - Ethereum only');
    console.log('   - User 3: Low reputation (30) - Ethereum + Polygon');
    console.log('   - User 4: Very high reputation (95) - Optimism only');
    console.log('   - User 5: New user (10) - Ethereum only');

    console.log('\n   Claims:');
    console.log('   - Claim 1: RESOLVED TRUE (95% confidence) - Finalized');
    console.log('   - Claim 2: RESOLVED FALSE (72% confidence) - Finalized');
    console.log('   - Claim 3: UNRESOLVED (58% confidence) - In Review');
    console.log('   - Claim 4: RESOLVED TRUE (88% confidence) - Finalized');
    console.log('   - Claim 5: NEW CLAIM (No verdict) - Awaiting Evidence');

    console.log('\n   Evidence:');
    console.log('   - Claim 1: 1 evidence with 2 versions');
    console.log('   - Claim 2: 1 evidence with 1 version');
    console.log('   - Claim 3: 2 evidence pieces with 1 version each');
    console.log('   - Claim 4: 1 evidence with 3 versions');

    console.log(
      '\n💡 To clear the database and reseed, use: npm run seed -- --clear',
    );
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
