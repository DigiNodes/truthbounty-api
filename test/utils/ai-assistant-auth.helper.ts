import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { ethers } from 'ethers';
import { PrismaService } from '../../src/prisma/prisma.service';

export interface TestAuthUser {
  accessToken: string;
  userId: string;
  walletAddress: string;
}

/**
 * Creates a Prisma User+Wallet with the given role, then runs the real
 * challenge/sign/login flow (src/auth) to obtain a JWT for that user —
 * so AI-assistant e2e tests exercise the same auth path production traffic
 * would use, including RBAC via the Prisma `role` column.
 */
export async function createAuthenticatedTestUser(
  app: INestApplication,
  role: 'contributor' | 'moderator' | 'admin' = 'contributor',
): Promise<TestAuthUser> {
  const prisma = app.get(PrismaService);
  const wallet = ethers.Wallet.createRandom();
  const address = wallet.address.toLowerCase();

  const user = await prisma.user.create({
    data: { walletAddress: address, role },
  });
  await prisma.wallet.create({
    data: { address, chain: 'ethereum', userId: user.id },
  });

  const challengeRes = await request(app.getHttpServer())
    .post('/auth/challenge')
    .send({ address: wallet.address });

  const signature = await wallet.signMessage(challengeRes.body.message);

  const loginRes = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ address: wallet.address, signature, message: challengeRes.body.message });

  return { accessToken: loginRes.body.accessToken, userId: user.id, walletAddress: address };
}
