import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';

@Injectable()
export class SessionService {
    private readonly logger = new Logger(SessionService.name);
    private readonly accessTokenExpiry = '15m'; // Short-lived access token

    constructor(
        private readonly jwtService: JwtService,
        private readonly dataSource: DataSource,
    ) {}

    async createSession(walletAddress: string): Promise<{ accessToken: string; refreshToken: string }> {
        const accessToken = this.jwtService.sign({ sub: walletAddress }, { expiresIn: this.accessTokenExpiry });
        
        const rawRefreshToken = crypto.randomBytes(32).toString('hex');
        const tokenFamily = crypto.randomUUID();
        const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

        await this.dataSource.query(
            `INSERT INTO "v2_refresh_sessions" ("wallet_address", "token_hash", "token_family", "revoked", "expires_at") VALUES ($1, $2, $3, FALSE, $4)`,
            [walletAddress, tokenHash, tokenFamily, expiresAt]
        );

        this.logger.log(`Created new refresh session for wallet: ${walletAddress}`);
        return { accessToken, refreshToken: rawRefreshToken };
    }

    async refreshSession(rawRefreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
        const tokenHash = crypto.createHash('sha256').update(rawRefreshToken).digest('hex');

        const sessionRecord = await this.dataSource.query(
            `SELECT * FROM "v2_refresh_sessions" WHERE "token_hash" = $1`,
            [tokenHash]
        );

        if (!sessionRecord || sessionRecord.length === 0) {
            throw new UnauthorizedException('Invalid refresh token.');
        }

        const session = sessionRecord[0];

        // 1. Check if token family was already revoked (Replay Attack Detection)
        if (session.revoked || session.expires_at < new Date()) {
            // Revoke the entire token family for security
            await this.dataSource.query(
                `UPDATE "v2_refresh_sessions" SET "revoked" = TRUE WHERE "token_family" = $1`,
                [session.token_family]
            );
            this.logger.warn(`Security alert: Refresh token replay detected for family ${session.token_family}. Full family revoked.`);
            throw new UnauthorizedException('Refresh token reuse detected. Session family revoked.');
        }

        // 2. Revoke current token (rotation)
        await this.dataSource.query(
            `UPDATE "v2_refresh_sessions" SET "revoked" = TRUE WHERE "id" = $1`,
            [session.id]
        );

        // 3. Issue new access token and rotated refresh token in the same family
        const accessToken = this.jwtService.sign({ sub: session.wallet_address }, { expiresIn: this.accessTokenExpiry });
        const newRawRefreshToken = crypto.randomBytes(32).toString('hex');
        const newTokenHash = crypto.createHash('sha256').update(newRawRefreshToken).digest('hex');
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        await this.dataSource.query(
            `INSERT INTO "v2_refresh_sessions" ("wallet_address", "token_hash", "token_family", "revoked", "expires_at") VALUES ($1, $2, $3, FALSE, $4)`,
            [session.wallet_address, newTokenHash, session.token_family, expiresAt]
        );

        return { accessToken, refreshToken: newRawRefreshToken };
    }

    async revokeSessionFamily(walletAddress: string, tokenFamily: string): Promise<void> {
        await this.dataSource.query(
            `UPDATE "v2_refresh_sessions" SET "revoked" = TRUE WHERE "wallet_address" = $1 AND "token_family" = $2`,
            [walletAddress, tokenFamily]
        );
        this.logger.log(`Revoked session family ${tokenFamily} for wallet ${walletAddress}`);
    }

    async getActiveSessions(walletAddress: string): Promise<any[]> {
        return this.dataSource.query(
            `SELECT "token_family", "created_at", "expires_at" FROM "v2_refresh_sessions" WHERE "wallet_address" = $1 AND "revoked" = FALSE AND "expires_at" > NOW()`,
            [walletAddress]
        );
    }
}