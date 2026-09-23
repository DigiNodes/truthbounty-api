// src/auth/wallet-linkage.service.ts
import { Injectable, UnauthorizedException, BadRequestException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { verifyMessage } from 'ethers';
import {
  AUTH_GENERIC_FAILURE_MESSAGE,
  constantTimeAddressEqual,
  timingSafeEqualUtf8,
} from '../common/utils/timing-safe.util';

@Injectable()
export class WalletLinkageService {
    private readonly logger = new Logger(WalletLinkageService.name);

    constructor(private readonly dataSource: DataSource) {}

    async linkWallet(userId: string, walletAddress: string, signature: string, challengeMessage: string): Promise<void> {
        const normalizedWallet = walletAddress.toLowerCase();

        // 1. Cryptographically verify fresh signature proves ownership of the wallet
        // (timing-safe, constant-shape: no short-circuit !== oracle, no distinct messages).
        try {
            const recoveredAddress = verifyMessage(challengeMessage, signature);
            if (!constantTimeAddressEqual(recoveredAddress, normalizedWallet)) {
                this.logger.warn('Wallet linking failed [address-mismatch]');
                throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
            }
        } catch (error) {
            if (error instanceof UnauthorizedException) throw error;
            this.logger.warn(`Wallet linking signature verification failed`);
            timingSafeEqualUtf8(challengeMessage, challengeMessage);
            throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
        }

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            // 2. Ensure wallet is not already linked to another active account
            const existing = await queryRunner.query(
                `SELECT * FROM "v2_user_wallets" WHERE "wallet_address" = $1 AND "unlinked_at" IS NULL`,
                [normalizedWallet]
            );

            if (existing && existing.length > 0) {
                // Redacted constant-shape: do not disclose linkage state details.
                throw new BadRequestException(AUTH_GENERIC_FAILURE_MESSAGE);
            }

            // 3. Persist canonical linkage record with verification timestamp
            await queryRunner.query(
                `INSERT INTO "v2_user_wallets" ("user_id", "wallet_address", "verified_at", "unlinked_at") VALUES ($1, $2, NOW(), NULL)`,
                [userId, normalizedWallet]
            );

            // 4. Record immutable audit history entry
            await queryRunner.query(
                `INSERT INTO "v2_audit_logs" ("actor", "action", "metadata") VALUES ($1, $2, $3)`,
                [normalizedWallet, 'WALLET_LINKED', JSON.stringify({ userId, walletAddress: normalizedWallet })]
            );

            await queryRunner.commitTransaction();
            this.logger.log(`Successfully linked wallet ${normalizedWallet} to user ${userId}`);
        } catch (error) {
            await queryRunner.rollbackTransaction();
            this.logger.error(`Failed to link wallet: ${error.message}`);
            throw error;
        } finally {
            await queryRunner.release();
        }
    }

    async unlinkWallet(userId: string, walletAddress: string, signature: string, challengeMessage: string): Promise<void> {
        const normalizedWallet = walletAddress.toLowerCase();

        try {
            const recoveredAddress = verifyMessage(challengeMessage, signature);
            if (!constantTimeAddressEqual(recoveredAddress, normalizedWallet)) {
                this.logger.warn('Wallet unlinking failed [address-mismatch]');
                throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
            }
        } catch (error) {
            if (error instanceof UnauthorizedException) throw error;
            timingSafeEqualUtf8(challengeMessage, challengeMessage);
            throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
        }

        const queryRunner = this.dataSource.createQueryRunner();
        await queryRunner.connect();
        await queryRunner.startTransaction();

        try {
            const record = await queryRunner.query(
                `SELECT * FROM "v2_user_wallets" WHERE "user_id" = $1 AND "wallet_address" = $2 AND "unlinked_at" IS NULL`,
                [userId, normalizedWallet]
            );

            if (!record || record.length === 0) {
                throw new BadRequestException(AUTH_GENERIC_FAILURE_MESSAGE);
            }

            // Atomically set unlinked timestamp
            await queryRunner.query(
                `UPDATE "v2_user_wallets" SET "unlinked_at" = NOW() WHERE "user_id" = $1 AND "wallet_address" = $2`,
                [userId, normalizedWallet]
            );

            await queryRunner.query(
                `INSERT INTO "v2_audit_logs" ("actor", "action", "metadata") VALUES ($1, $2, $3)`,
                [normalizedWallet, 'WALLET_UNLINKED', JSON.stringify({ userId, walletAddress: normalizedWallet })]
            );

            await queryRunner.commitTransaction();
            this.logger.log(`Successfully unlinked wallet ${normalizedWallet} from user ${userId}`);
        } catch (error) {
            await queryRunner.rollbackTransaction();
            throw error;
        } finally {
            await queryRunner.release();
        }
    }
}