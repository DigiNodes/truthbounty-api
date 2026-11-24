import { getRuntimeEnvironment } from '../config/runtime-config';
// src/auth/siwe-nonce.service.ts
import {
  Injectable,
  Logger,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { generateNonce } from 'siwe';

/**
 * Issues, persists, and atomically consumes single-use SIWE (EIP-4361) challenge nonces.
 *
 * Nonces are generated cryptographically server-side using the canonical `siwe` library
 * (never client-supplied), persisted atomically per wallet, and single-use.
 *
 * Consumption enforces race-safety via conditional atomic updates (never read-then-write)
 * to prevent replay attacks under concurrent requests.
 *
 * Policy is aligned with #414 and fail-closed: wallet, URI, and chain ID inputs
 * are treated as untrusted and strictly validated.
 */
@Injectable()
export class SiweNonceService {
  private readonly logger = new Logger(SiweNonceService.name);
  private readonly domain =
    getRuntimeEnvironment().SIWE_DOMAIN || 'truthbounty.app';
  private readonly nonceExpiryMinutes = 5;
  private readonly allowedOrigins: string[];
  private readonly supportedChainIds: number[];

  constructor(private readonly dataSource: DataSource) {
    this.allowedOrigins = (getRuntimeEnvironment().SIWE_ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const rawChainIds =
      getRuntimeEnvironment().SIWE_SUPPORTED_CHAIN_IDS || '10,11155420';
    this.supportedChainIds = rawChainIds
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0);
  }

  /**
   * Issue a cryptographic SIWE challenge nonce and canonical EIP-4361 message.
   * Invalidates any outstanding unconsumed nonces for the wallet.
   */
  async issueNonceChallenge(
    walletAddress: string,
    uri: string,
    chainId: number,
  ): Promise<{ nonce: string; siweMessage: string }> {
    this.assertValidAddress(walletAddress);
    this.assertValidUri(uri);
    this.assertValidChainId(chainId);

    const normalizedWallet = walletAddress.toLowerCase();
    const nonce = generateNonce();
    const expiresAt = new Date(
      Date.now() + this.nonceExpiryMinutes * 60 * 1000,
    );

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Atomically invalidate any superseded active nonces for this wallet
      await queryRunner.query(
        `UPDATE "v2_auth_nonces" SET "used" = TRUE WHERE "wallet_address" = $1 AND "used" = FALSE`,
        [normalizedWallet],
      );

      // 2. Persist new challenge nonce state
      await queryRunner.query(
        `INSERT INTO "v2_auth_nonces" ("wallet_address", "nonce", "expires_at", "used") VALUES ($1, $2, $3, FALSE)`,
        [normalizedWallet, nonce, expiresAt],
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
        `Issued At: ${issuedAt}`,
      ].join('\n');

      this.logger.log(
        `Issued cryptographic SIWE nonce for wallet: ${normalizedWallet}`,
      );
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
   * Atomically verifies and consumes a single-use nonce.
   *
   * To prevent replay and race conditions under concurrent requests, consumption
   * is executed as a conditional UPDATE (`WHERE used = FALSE AND expires_at > NOW()`).
   * Exactly one concurrent caller can succeed; any concurrent competitor or replay
   * attempt fails closed.
   */
  async consumeNonce(walletAddress: string, nonce: string): Promise<void> {
    this.assertValidAddress(walletAddress);
    this.assertValidNonce(nonce);

    const normalizedWallet = walletAddress.toLowerCase();
    const now = new Date();

    // Conditional atomic update — race-safe single-use transition
    const updateResult: unknown = await this.dataSource.query(
      `UPDATE "v2_auth_nonces" SET "used" = TRUE WHERE "wallet_address" = $1 AND "nonce" = $2 AND "used" = FALSE AND "expires_at" > $3 RETURNING "id"`,
      [normalizedWallet, nonce, now],
    );

    const rowsUpdated = this.extractAffectedRows(updateResult);

    if (rowsUpdated === 1) {
      this.logger.log(
        `Nonce consumed successfully for wallet: ${normalizedWallet}`,
      );
      return;
    }

    // 0 rows updated: determine the exact diagnostic reason to fail closed
    const records: Array<{
      id: number;
      wallet_address: string;
      nonce: string;
      expires_at: Date | string;
      used: boolean;
    }> = await this.dataSource.query(
      `SELECT "id", "wallet_address", "nonce", "expires_at", "used" FROM "v2_auth_nonces" WHERE "nonce" = $1`,
      [nonce],
    );

    if (!records || records.length === 0) {
      throw new UnauthorizedException('Invalid or unknown nonce');
    }

    const record = records[0];
    if (record.wallet_address.toLowerCase() !== normalizedWallet) {
      throw new UnauthorizedException('Nonce wallet address binding mismatch');
    }

    if (record.used) {
      throw new UnauthorizedException(
        'Nonce has already been used (replay attack prevented)',
      );
    }

    const expiresAt = new Date(record.expires_at);
    if (expiresAt <= now) {
      throw new UnauthorizedException('Nonce has expired');
    }

    throw new UnauthorizedException(
      'Nonce is invalid, expired, or has already been used',
    );
  }

  private extractAffectedRows(result: unknown): number {
    if (Array.isArray(result)) {
      if (
        result.length > 0 &&
        typeof result[0] === 'object' &&
        result[0] !== null &&
        'id' in result[0]
      ) {
        return result.length;
      }
      if (typeof result[1] === 'number') {
        return result[1];
      }
      return result.length;
    }
    if (
      result &&
      typeof result === 'object' &&
      'affected' in result &&
      typeof (result as { affected?: number }).affected === 'number'
    ) {
      return (result as { affected: number }).affected;
    }
    return 0;
  }

  private assertValidAddress(address: string): void {
    if (
      !address ||
      typeof address !== 'string' ||
      !address.match(/^0x[0-9a-fA-F]{40}$/)
    ) {
      throw new BadRequestException('Invalid EVM address');
    }
  }

  private assertValidUri(uri: string): void {
    if (!uri || typeof uri !== 'string') {
      throw new BadRequestException('URI must not be empty');
    }
    let origin: string;
    try {
      origin = new URL(uri).origin;
    } catch {
      throw new BadRequestException('Malformed SIWE URI');
    }
    if (
      this.allowedOrigins.length > 0 &&
      !this.allowedOrigins.includes(origin)
    ) {
      throw new BadRequestException(`Unsupported SIWE origin: ${origin}`);
    }
  }

  private assertValidChainId(chainId: number): void {
    if (!Number.isInteger(chainId) || chainId <= 0) {
      throw new BadRequestException('chainId must be a positive integer');
    }
    if (
      this.supportedChainIds.length > 0 &&
      !this.supportedChainIds.includes(chainId)
    ) {
      throw new BadRequestException(`Unsupported SIWE chain ID: ${chainId}`);
    }
  }

  private assertValidNonce(nonce: string): void {
    if (
      !nonce ||
      typeof nonce !== 'string' ||
      nonce.length < 8 ||
      !/^[a-zA-Z0-9]+$/.test(nonce)
    ) {
      throw new BadRequestException('Invalid nonce format');
    }
  }
}
