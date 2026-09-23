// src/auth/siwe-verification.service.ts
import { Injectable, UnauthorizedException, BadRequestException, Logger } from '@nestjs/common';
import { SiweMessage } from 'siwe';
import { DataSource } from 'typeorm';
import {
  AUTH_GENERIC_FAILURE_MESSAGE,
  timingSafeEqualUtf8,
} from '../common/utils/timing-safe.util';

@Injectable()
export class SiweVerificationService {
    private readonly logger = new Logger(SiweVerificationService.name);
    private readonly expectedChainId = 10; // Optimism Mainnet (or configure via ConfigService)
    private readonly expectedDomain = process.env.SIWE_DOMAIN || 'truthbounty.app';

    constructor(private readonly dataSource: DataSource) {}

    async verifySiweMessage(messageStr: string, signature: string, clientNonce: string): Promise<string> {
        let siweMessage: SiweMessage;
        
        try {
            siweMessage = new SiweMessage(messageStr);
        } catch (error) {
            this.logger.warn(`Malformed SIWE message parsing failed: ${error.message}`);
            throw new BadRequestException('Malformed EIP-4361 message structure.');
        }

        // 1. Verify Domain & Chain ID constraints (timing-safe, redacted,
        // constant-shape: distinct values never echoed, same 401 message).
        if (!timingSafeEqualUtf8(siweMessage.domain, this.expectedDomain)) {
            this.logger.warn('SIWE verification failed [domain]');
            throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
        }

        if (siweMessage.chainId !== this.expectedChainId) {
            this.logger.warn('SIWE verification failed [chain-id]');
            throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
        }

        // 2. Verify Nonce against v2_auth_nonces table (timing-safe, Replay prevention)
        if (!timingSafeEqualUtf8(siweMessage.nonce, clientNonce)) {
            this.logger.warn('SIWE verification failed [nonce-mismatch]');
            throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
        }

        const nonceRecord = await this.dataSource.query(
            `SELECT * FROM "v2_auth_nonces" WHERE "wallet_address" = $1 AND "nonce" = $2 AND "used" = FALSE AND "expires_at" > NOW()`,
            [siweMessage.address.toLowerCase(), clientNonce]
        );

        if (!nonceRecord || nonceRecord.length === 0) {
            this.logger.warn('SIWE verification failed [nonce-invalid]');
            timingSafeEqualUtf8(clientNonce, clientNonce);
            throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
        }

        // 3. Verify cryptographic signature & expiration/issued-at
        try {
            const verificationResult = await siweMessage.verify({ signature });
            if (!verificationResult.success) {
                this.logger.warn('SIWE verification failed [signature-verify]');
                throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
            }
        } catch (error) {
            this.logger.error(`Signature verification error: ${error.message}`);
            throw new UnauthorizedException(AUTH_GENERIC_FAILURE_MESSAGE);
        }

        // 4. Mark nonce as used to prevent replay
        await this.dataSource.query(
            `UPDATE "v2_auth_nonces" SET "used" = TRUE WHERE "wallet_address" = $1 AND "nonce" = $2`,
            [siweMessage.address.toLowerCase(), clientNonce]
        );

        this.logger.log(`SIWE verification successful for address: ${siweMessage.address}`);
        return siweMessage.address.toLowerCase();
    }
}