// src/auth/siwe-verification.service.ts
import { Injectable, UnauthorizedException, BadRequestException, Logger } from '@nestjs/common';
import { SiweMessage } from 'siwe';
import { DataSource } from 'typeorm';

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

        // 1. Verify Domain & Chain ID constraints
        if (siweMessage.domain !== this.expectedDomain) {
            throw new UnauthorizedException(`Invalid domain: expected ${this.expectedDomain}, got ${siweMessage.domain}`);
        }

        if (siweMessage.chainId !== this.expectedChainId) {
            throw new UnauthorizedException(`Invalid chain ID: expected Optimism chain ID ${this.expectedChainId}, got ${siweMessage.chainId}`);
        }

        // 2. Verify Nonce against v2_auth_nonces table (Replay prevention)
        if (siweMessage.nonce !== clientNonce) {
            throw new UnauthorizedException('Nonce mismatch between payload and request context.');
        }

        const nonceRecord = await this.dataSource.query(
            `SELECT * FROM "v2_auth_nonces" WHERE "wallet_address" = $1 AND "nonce" = $2 AND "used" = FALSE AND "expires_at" > NOW()`,
            [siweMessage.address.toLowerCase(), clientNonce]
        );

        if (!nonceRecord || nonceRecord.length === 0) {
            throw new UnauthorizedException('Nonce is invalid, expired, or has already been used (replay attack prevented).');
        }

        // 3. Verify cryptographic signature & expiration/issued-at
        try {
            const verificationResult = await siweMessage.verify({ signature });
            if (!verificationResult.success) {
                throw new UnauthorizedException('Cryptographic EIP-4361 signature verification failed.');
            }
        } catch (error) {
            this.logger.error(`Signature verification error: ${error.message}`);
            throw new UnauthorizedException('Invalid signature or expired EIP-4361 message.');
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