import { getRuntimeEnvironment } from '../config/runtime-config';
// src/auth/siwe-verification.service.ts
import { Injectable, UnauthorizedException, BadRequestException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SiweService } from './services/siwe.service';
import { SiweNonceService } from './siwe-nonce.service';
import { SiweVerifyResult } from './types/siwe.types';

/**
 * Strict SIWE (EIP-4361) verification for the V2 authentication path.
 *
 * Delegates EIP-4361 parsing, signature recovery, and the full set of
 * domain / origin / chain / statement / nonce / time / resource checks to
 * the canonical {@link SiweService}, then enforces single-use replay
 * protection against the persisted `v2_auth_nonces` table. The validation
 * is fail-closed: every uncertainty rejects the signature.
 */
@Injectable()
export class SiweVerificationService {
    private readonly logger = new Logger(SiweVerificationService.name);
    private readonly expectedChainId = Number(getRuntimeEnvironment().CHAIN_ID);
    private readonly expectedDomain = getRuntimeEnvironment().SIWE_DOMAIN || 'truthbounty.app';
    private readonly allowedOrigins = (getRuntimeEnvironment().SIWE_ALLOWED_ORIGINS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    constructor(
        private readonly dataSource: DataSource,
        private readonly siweService: SiweService,
        private readonly siweNonceService?: SiweNonceService,
    ) {}

    async verifySiweMessage(messageStr: string, signature: string, clientNonce: string): Promise<string> {
        // 1. Strict EIP-4361 verification (signature + domain/origin/chain/statement/nonce/time/resources).
        let result: SiweVerifyResult;
        try {
            result = await this.siweService.verifySiwe({
                message: messageStr,
                signature,
                expectedChainId: this.expectedChainId,
                expectedDomain: this.expectedDomain,
                allowedOrigins: this.allowedOrigins,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn(`SIWE verification failed: ${message}`);
            throw new BadRequestException('Malformed EIP-4361 message structure.');
        }

        if (!result.success || !result.data) {
            this.logger.warn(`SIWE verification rejected: ${result.error}`);
            throw new UnauthorizedException(
                `SIWE verification failed (${result.error ?? 'UNKNOWN'}).`,
            );
        }

        const parsed = result.data;

        // 2. Verify nonce matches the request-context nonce (replay binding).
        if (parsed.nonce !== clientNonce) {
            throw new UnauthorizedException('Nonce mismatch between payload and request context.');
        }

        // 3. Atomically consume nonce to enforce single-use and prevent replay (race-safe).
        if (this.siweNonceService) {
            await this.siweNonceService.consumeNonce(parsed.address, clientNonce);
        } else {
            const updateResult = await this.dataSource.query(
                `UPDATE "v2_auth_nonces" SET "used" = TRUE WHERE "wallet_address" = $1 AND "nonce" = $2 AND "used" = FALSE AND "expires_at" > NOW() RETURNING "id"`,
                [parsed.address.toLowerCase(), clientNonce]
            );
            if (!updateResult || (Array.isArray(updateResult) && updateResult.length === 0)) {
                throw new UnauthorizedException('Nonce is invalid, expired, or has already been used (replay attack prevented).');
            }
        }

        this.logger.log(`SIWE verification successful for address: ${parsed.address}`);
        return parsed.address.toLowerCase();
    }
}
