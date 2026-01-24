import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { Wallet } from 'ethers';

describe('Identity (e2e)', () => {
  let app: INestApplication;
  let userId: string;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe());
    await app.init();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('/identity/users (POST) should create a user', async () => {
    const res = await request(app.getHttpServer())
      .post('/identity/users')
      .expect(201);
    
    expect(res.body.id).toBeDefined();
    userId = res.body.id;
  });

  it('should link a wallet with valid signature', async () => {
    // Ensure user exists (re-create for isolation if needed, but we use shared userId from previous test if sequential, 
    // but jest runs parallel by default unless runInBand. Best to create user here.)
    const userRes = await request(app.getHttpServer()).post('/identity/users');
    const uid = userRes.body.id;

    const wallet = Wallet.createRandom();
    const message = 'Link this wallet to my account';
    const signature = await wallet.signMessage(message);

    await request(app.getHttpServer())
      .post(`/identity/users/${uid}/wallets`)
      .send({
        address: wallet.address,
        chain: 'ETH',
        signature,
        message,
      })
      .expect(201);
    
    // Verify wallet is linked
    const user = await request(app.getHttpServer()).get(`/identity/users/${uid}`);
    expect(user.body.wallets).toHaveLength(1);
    expect(user.body.wallets[0].address).toBe(wallet.address);
  });

  it('should fail to link wallet with invalid signature', async () => {
    const userRes = await request(app.getHttpServer()).post('/identity/users');
    const uid = userRes.body.id;

    const wallet = Wallet.createRandom();
    const message = 'Link this wallet';
    const signature = await wallet.signMessage('Different message');

    await request(app.getHttpServer())
      .post(`/identity/users/${uid}/wallets`)
      .send({
        address: wallet.address,
        chain: 'ETH',
        signature,
        message, // Server verifies this message against signature. If signature was for "Different message", it recovers different address.
      })
      .expect(400);
  });

  it('should prevent linking same wallet to different user', async () => {
    // User 1
    const u1 = await request(app.getHttpServer()).post('/identity/users');
    const uid1 = u1.body.id;
    
    // User 2
    const u2 = await request(app.getHttpServer()).post('/identity/users');
    const uid2 = u2.body.id;

    const wallet = Wallet.createRandom();
    const message = 'Link me';
    const signature = await wallet.signMessage(message);

    // Link to User 1
    await request(app.getHttpServer())
      .post(`/identity/users/${uid1}/wallets`)
      .send({
        address: wallet.address,
        chain: 'ETH',
        signature,
        message,
      })
      .expect(201);

    // Link to User 2 (Should fail)
    await request(app.getHttpServer())
      .post(`/identity/users/${uid2}/wallets`)
      .send({
        address: wallet.address, // Same address
        chain: 'ETH', // Same chain (or different, logic says NO wallet mapped to multiple users)
        signature,
        message,
      })
      .expect(409); // Conflict
  });
  
  it('should allow linking same wallet to SAME user (idempotent or multi-chain)', async () => {
     const u1 = await request(app.getHttpServer()).post('/identity/users');
     const uid1 = u1.body.id;
 
     const wallet = Wallet.createRandom();
     const message = 'Link me';
     const signature = await wallet.signMessage(message);
 
     // Link ETH
     await request(app.getHttpServer())
       .post(`/identity/users/${uid1}/wallets`)
       .send({
         address: wallet.address,
         chain: 'ETH',
         signature,
         message,
       })
       .expect(201);
 
     // Link OPT (Same user, different chain)
     await request(app.getHttpServer())
       .post(`/identity/users/${uid1}/wallets`)
       .send({
         address: wallet.address,
         chain: 'OPT',
         signature,
         message,
       })
       .expect(201);

     const user = await request(app.getHttpServer()).get(`/identity/users/${uid1}`);
     expect(user.body.wallets).toHaveLength(2);
  });
});
