// src/auth/siwe-nonce.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomBytes } from 'crypto';

/**
 * Issues and persists single-use SIWE (EIP-4361) challenge nonces.
 *
 * Nonces are generated cryptographically server-side (never client-supplied),
 * persisted atomically per wallet, and single-use. EIP-4361 §2.3 requires a
 * nonce of at least 8 alphanumeric characters — 32 alphanumeric characters
 * are generated here.
 */
@Injectable()
export class SiweNonceService {
    private readonly logger = new Logger(SiweNonceService.name);
    private readonly domain = process.env.SIWE_DOMAIN || 'truthbounty.app';
    private readonly nonceExpiryMinutes = 5;

    constructor(private readonly dataSource: DataSource) {}

    async issueNonceChallenge(walletAddress: string, uri: string, chainId: number): Promise<{ nonce: string; siweMessage: string }> {
        const normalizedWallet = walletAddress.toLowerCase();
        const nonce = this.generateNonce();
        const expiresAt = new Date(Date.now() + this.nonceExpiryMinutes * 60 * 1000);

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // 1. Atomically invalidate any superseded or active nonces for this wallet
            await queryRunner.query(
                `UPDATE "v2_auth_nonces" SET "used" = TRUE WHERE "wallet_address" = $1 AND "used" = FALSE`,
                [normalizedWallet]
            );

            // 2. Persist new challenge nonce state
            await queryRunner.query(
                `INSERT INTO "v2_auth_nonces" ("wallet_address", "nonce", "expires_at", "used") VALUES ($1, $2, $3, FALSE)`,
                [normalizedWallet, nonce, expiresAt]
            );

            await queryRunner.commitTransaction();

            // 3. Construct exact canonical EIP-4361 message format
            const issuedAt = new Date().toISOString();
            const statement = 'Sign in to TruthBounty V2 to verify wallet ownership.';

            const siweMessage = [
                `${this.domain} wants you to sign in with your Ethereum account:`,
                normalizedWallet,
                '',
                statement,
                '',
                `URI: ${uri}`,
                `Version: 1`,
                `Chain ID: ${chainId}`,
                `Nonce: ${nonce}`,
                `Issued At: ${issuedAt}`
            ].join('\n');

            this.logger.log(`Issued cryptographic SIWE nonce for wallet: ${normalizedWallet}`);
            return { nonce, siweMessage };
        } catch (error) {
            await queryRunner.rollbackTransaction();
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Failed to issue SIWE nonce challenge: ${message}`);
            throw error;
        } finally {
            await queryRunner.release();
        }
    }

    /**
     * Generate a 32-character cryptographically random alphanumeric nonce
     * satisfying EIP-4361 §2.3 (>= 8 alphanumeric characters).
     */
    private generateNonce(): string {
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        const bytes = randomBytes(32);
        let nonce = '';
        for (let i = 0; i < 32; i++) {
            nonce += alphabet[bytes[i] % alphabet.length];
        }
        return nonce;
    }
}
