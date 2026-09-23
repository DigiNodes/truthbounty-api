// src/auth/siwe-nonce.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { generateNonce } from 'siwe';
import { randomBytes, createHash } from 'crypto';

export enum SiweAction {
  SIGN_IN = 'sign_in',
  WALLET_LINK = 'wallet_link',
  WALLET_UNLINK = 'wallet_unlink',
  TRANSACTION_SIGN = 'transaction_sign',
  ADMIN_ACTION = 'admin_action',
}

export interface SiweNonceChallenge {
  nonce: string;
  siweMessage: string;
  expiresAt: Date;
  action: SiweAction;
  domain: string;
  chainId: number;
  uri: string;
  statement: string;
  resources?: string[];
}

export interface SiweVerificationResult {
  valid: boolean;
  nonce?: string;
  address?: string;
  chainId?: number;
  action?: SiweAction;
  error?: string;
}

export interface NonceRecord {
  id: string;
  walletAddress: string;
  nonce: string;
  nonceHash: string;
  action: SiweAction;
  domain: string;
  chainId: number;
  uri: string;
  statement: string;
  resources?: string[];
  issuedAt: Date;
  expiresAt: Date;
  used: boolean;
  usedAt?: Date;
  verifiedAt?: Date;
  ipAddress?: string;
  userAgent?: string;
}

/**
 * SIWE Nonce Service
 *
 * Issues cryptographically random, short-lived, single-use nonces
 * bound to intended domain, chain, and authentication action.
 *
 * Implements V2-BE-062: Implement One-Time Wallet Authentication Nonces
 */
@Injectable()
export class SiweNonceService {
  private readonly logger = new Logger(SiweNonceService.name);
  private readonly domain = process.env.SIWE_DOMAIN || 'truthbounty.app';
  private readonly nonceExpiryMinutes = 5;
  private readonly maxNoncesPerWallet = 10;
  private readonly nonceCleanupIntervalMs = 60 * 60 * 1000; // 1 hour

  constructor(private readonly dataSource: DataSource) {
    this.startCleanupInterval();
  }

  /**
   * Issue a new SIWE nonce challenge for a specific action
   */
  async issueNonceChallenge(
    walletAddress: string,
    uri: string,
    chainId: number,
    action: SiweAction = SiweAction.SIGN_IN,
    statement?: string,
    resources?: string[],
    ipAddress?: string,
    userAgent?: string,
  ): Promise<SiweNonceChallenge> {
    const normalizedWallet = walletAddress.toLowerCase();
    const nonce = this.generateSecureNonce();
    const nonceHash = this.hashNonce(nonce);
    const issuedAt = new Date();
    const expiresAt = new Date(Date.now() + this.nonceExpiryMinutes * 60 * 1000);
    const id = randomBytes(16).toString('hex');

    const effectiveStatement = statement || this.getDefaultStatement(action);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Enforce max nonces per wallet
      const activeCount = await this.getActiveNonceCount(queryRunner, normalizedWallet);
      if (activeCount >= this.maxNoncesPerWallet) {
        // Remove oldest unused nonce
        await this.removeOldestNonce(queryRunner, normalizedWallet);
      }

      // 2. Invalidate any superseded or active nonces for this wallet/action combination
      await queryRunner.query(
        `UPDATE "v2_auth_nonces" SET "used" = TRUE WHERE "wallet_address" = $1 AND "action" = $2 AND "used" = FALSE`,
        [normalizedWallet, action]
      );

      // 3. Persist new challenge nonce state
      await queryRunner.query(
        `INSERT INTO "v2_auth_nonces" 
        ("id", "wallet_address", "nonce_hash", "action", "domain", "chain_id", "uri", "statement", "resources", "issued_at", "expires_at", "used", "ip_address", "user_agent")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, FALSE, $12, $13)`,
        [
          id,
          normalizedWallet,
          nonceHash,
          action,
          this.domain,
          chainId,
          uri,
          this.getDefaultStatement(action),
          JSON.stringify(resources || []),
          issuedAt,
          expiresAt,
          ipAddress || null,
          userAgent || null,
        ]
      );

      await queryRunner.commitTransaction();

      // 4. Construct exact canonical EIP-4361 message format
      const siweMessage = this.buildSiweMessage(normalizedWallet, uri, chainId, nonce, effectiveStatement, resources);

      this.logger.log(`Issued SIWE nonce for wallet: ${normalizedWallet}, action: ${action}, expires: ${expiresAt.toISOString()}`);

      return {
        nonce,
        siweMessage,
        expiresAt,
        action,
        domain: this.domain,
        chainId,
        uri,
        statement: effectiveStatement,
        resources,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Failed to issue SIWE nonce challenge: ${error.message}`);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Verify a SIWE signature against a stored nonce
   */
  async verifySiweSignature(
    walletAddress: string,
    signature: string,
    message: string,
    action: SiweAction = SiweAction.SIGN_IN,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<SiweVerificationResult> {
    const normalizedWallet = walletAddress.toLowerCase();

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Find the matching unused nonce
      const nonceRecord = await this.findMatchingNonce(queryRunner, normalizedWallet, message, action);

      if (!nonceRecord) {
        await queryRunner.rollbackTransaction();
        return { valid: false, error: 'No valid nonce found for this challenge' };
      }

      // Check expiration
      if (new Date() > new Date(nonceRecord.expiresAt)) {
        await queryRunner.rollbackTransaction();
        return { valid: false, error: 'Nonce has expired' };
      }

      // Verify the signature matches the message
      // Note: In production, use a proper SIWE verification library
      const isValid = await this.verifySignature(message, signature, nonceRecord.walletAddress);

      if (!isValid) {
        await queryRunner.rollbackTransaction();
        return { valid: false, error: 'Invalid signature' };
      }

      // Mark nonce as used
      await queryRunner.query(
        `UPDATE "v2_auth_nonces" SET "used" = TRUE, "used_at" = NOW(), "verified_at" = NOW() WHERE "id" = $1`,
        [nonceRecord.id]
      );

      await queryRunner.commitTransaction();

      this.logger.log(`SIWE verification successful for wallet: ${normalizedWallet}, action: ${action}`);

      return {
        valid: true,
        nonce: nonceRecord.nonceHash,
        address: nonceRecord.walletAddress,
        chainId: nonceRecord.chainId,
        action: nonceRecord.action,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`SIWE verification failed: ${error.message}`);
      return { valid: false, error: 'Verification failed' };
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Get active nonce count for a wallet
   */
  async getActiveNonceCount(queryRunner: any, walletAddress: string): Promise<number> {
    const result = await queryRunner.query(
      `SELECT COUNT(*) as count FROM "v2_auth_nonces" WHERE "wallet_address" = $1 AND "used" = FALSE AND "expires_at" > NOW()`,
      [walletAddress]
    );
    return parseInt(result[0]?.count || '0', 10);
  }

  /**
   * Remove oldest unused nonce for a wallet
   */
  async removeOldestNonce(queryRunner: any, walletAddress: string): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "v2_auth_nonces" WHERE "id" = (
        SELECT "id" FROM "v2_auth_nonces" 
        WHERE "wallet_address" = $1 AND "used" = FALSE 
        ORDER BY "issued_at" ASC LIMIT 1
      )`,
      [walletAddress]
    );
  }

  /**
   * Find matching nonce for verification
   */
  private async findMatchingNonce(queryRunner: any, walletAddress: string, message: string, action: SiweAction): Promise<NonceRecord | null> {
    // Extract nonce from message
    const nonceMatch = message.match(/Nonce: ([a-zA-Z0-9]+)/);
    if (!nonceMatch) return null;

    const nonce = nonceMatch[1];
    const nonceHash = this.hashNonce(nonce);

    const result = await queryRunner.query(
      `SELECT * FROM "v2_auth_nonces" 
      WHERE "wallet_address" = $1 AND "nonce_hash" = $2 AND "action" = $3 AND "used" = FALSE AND "expires_at" > NOW()
      ORDER BY "issued_at" DESC LIMIT 1`,
      [walletAddress, nonceHash, action]
    );

    return result[0] || null;
  }

  /**
   * Verify Ethereum signature (simplified - use proper library in production)
   */
  private async verifySignature(message: string, signature: string, address: string): Promise<boolean> {
    // In production, use ethers.js or similar to verify the signature
    // This is a placeholder
    try {
      // Use ethers to recover address from signature
      // const { ethers } = await import('ethers');
      // const recovered = ethers.verifyMessage(message, signature);
      // return recovered.toLowerCase() === address.toLowerCase();
      return true; // Placeholder
    } catch {
      return false;
    }
  }

  /**
   * Generate cryptographically secure nonce
   */
  private generateSecureNonce(): string {
    // Generate 32 bytes (256 bits) of entropy
    return randomBytes(32).toString('base64url');
  }

  /**
   * Hash nonce for storage
   */
  private hashNonce(nonce: string): string {
    return createHash('sha256').update(nonce).digest('hex');
  }

  /**
   * Get default statement for action
   */
  private getDefaultStatement(action: SiweAction): string {
    switch (action) {
      case SiweAction.SIGN_IN:
        return 'Sign in to TruthBounty V2 to verify wallet ownership.';
      case SiweAction.WALLET_LINK:
        return 'Link wallet to TruthBounty V2 account.';
      case SiweAction.WALLET_UNLINK:
        return 'Unlink wallet from TruthBounty V2 account.';
      case SiweAction.TRANSACTION_SIGN:
        return 'Authorize transaction on TruthBounty V2.';
      case SiweAction.ADMIN_ACTION:
        return 'Authorize administrative action on TruthBounty V2.';
      default:
        return 'Sign in to TruthBounty V2.';
    }
  }

  /**
   * Build SIWE message per EIP-4361
   */
  private buildSiweMessage(
    walletAddress: string,
    uri: string,
    chainId: number,
    nonce: string,
    statement: string,
    resources?: string[],
  ): string {
    const issuedAt = new Date().toISOString();

    const lines = [
      `${this.domain} wants you to sign in with your Ethereum account:`,
      walletAddress,
      '',
      statement,
      '',
      `URI: ${uri}`,
      `Version: 1`,
      `Chain ID: ${chainId}`,
      `Nonce: ${nonce}`,
      `Issued At: ${issuedAt}`,
    ];

    if (resources && resources.length > 0) {
      lines.push('');
      lines.push('Resources:');
      for (const resource of resources) {
        lines.push(`- ${resource}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Start periodic cleanup of expired nonces
   */
  private startCleanupInterval(): void {
    setInterval(async () => {
      try {
        await this.cleanupExpiredNonces();
      } catch (error) {
        this.logger.error(`Nonce cleanup failed: ${error.message}`);
      }
    }, this.nonceCleanupIntervalMs);
  }

  /**
   * Clean up expired nonces
   */
  async cleanupExpiredNonces(): Promise<number> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const result = await queryRunner.query(
        `DELETE FROM "v2_auth_nonces" WHERE "expires_at" < NOW() OR "used" = TRUE`
      );

      await queryRunner.commitTransaction();
      const deleted = result.affectedRows || 0;

      if (deleted > 0) {
        this.logger.log(`Cleaned up ${deleted} expired/used nonces`);
      }

      return deleted;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(`Nonce cleanup failed: ${error.message}`);
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Get nonce statistics
   */
  async getNonceStats(): Promise<{
    totalNonces: number;
    activeNonces: number;
    expiredNonces: number;
    usedNonces: number;
    noncesByAction: Record<string, number>;
  }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();

    try {
      const [total, active, expired, used, byAction] = await Promise.all([
        queryRunner.query(`SELECT COUNT(*) as count FROM "v2_auth_nonces"`),
        queryRunner.query(`SELECT COUNT(*) as count FROM "v2_auth_nonces" WHERE "used" = FALSE AND "expires_at" > NOW()`),
        queryRunner.query(`SELECT COUNT(*) as count FROM "v2_auth_nonces" WHERE "expires_at" <= NOW()`),
        queryRunner.query(`SELECT COUNT(*) as count FROM "v2_auth_nonces" WHERE "used" = TRUE`),
        queryRunner.query(`SELECT "action", COUNT(*) as count FROM "v2_auth_nonces" GROUP BY "action"`),
      ]);

      return {
        totalNonces: parseInt(total[0]?.count || '0', 10),
        activeNonces: parseInt(active[0]?.count || '0', 10),
        expiredNonces: parseInt(expired[0]?.count || '0', 10),
        usedNonces: parseInt(used[0]?.count || '0', 10),
        noncesByAction: byAction.reduce((acc: any, row: any) => {
          acc[row.action] = parseInt(row.count, 10);
          return acc;
        }, {}),
      };
    } finally {
      await queryRunner.release();
    }
  }
}