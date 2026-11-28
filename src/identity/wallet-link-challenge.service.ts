import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { getAddress } from 'ethers';
import {
  constantTimeAddressEqual,
  timingSafeEqualUtf8,
} from '../common/utils/timing-safe.util';

export const WALLET_LINK_OPERATION = 'wallet_link' as const;
export type WalletLinkOperation = typeof WALLET_LINK_OPERATION;

/** Default challenge lifetime: 5 minutes. */
const DEFAULT_CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface WalletLinkChallenge {
  nonce: string;
  userId: string;
  address: string;
  chain: string;
  operation: WalletLinkOperation;
  message: string;
  expiresAt: Date;
}

interface WalletLinkChallengeRecord extends WalletLinkChallenge {
  consumed: boolean;
}

export interface IssueWalletLinkChallengeParams {
  userId: string;
  address: string;
  chain: string;
  ttlMs?: number;
}

export interface VerifyAndConsumeWalletLinkChallengeParams {
  nonce: string;
  userId: string;
  address: string;
  chain: string;
  operation: WalletLinkOperation;
  message: string;
  verifySignature: () => void;
}

/**
 * Issues and atomically consumes server-generated, single-use wallet-link
 * challenges bound to account (userId), wallet address, chain, operation,
 * and expiry.
 *
 * Consumption is synchronous (no awaits between validation, signature check,
 * and marking consumed), so concurrent replay attempts with the same nonce
 * cannot both succeed.
 */
@Injectable()
export class WalletLinkChallengeService {
  private readonly logger = new Logger(WalletLinkChallengeService.name);
  private readonly challenges = new Map<string, WalletLinkChallengeRecord>();

  issueChallenge(
    params: IssueWalletLinkChallengeParams,
  ): WalletLinkChallenge {
    const userId = params.userId?.trim();
    const chain = params.chain?.trim();
    const ttlMs = params.ttlMs ?? DEFAULT_CHALLENGE_TTL_MS;

    if (!userId) {
      throw new BadRequestException('Invalid account identifier');
    }
    if (!chain) {
      throw new BadRequestException('Invalid chain identifier');
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new BadRequestException('Invalid challenge TTL');
    }

    const normalizedAddress = this.normalizeAddress(params.address);
    this.pruneExpired();

    const nonce = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + ttlMs);
    const operation: WalletLinkOperation = WALLET_LINK_OPERATION;
    const message = this.formatMessage({
      operation,
      userId,
      address: normalizedAddress,
      chain,
      nonce,
      expiresAt,
    });

    const record: WalletLinkChallengeRecord = {
      nonce,
      userId,
      address: normalizedAddress,
      chain,
      operation,
      message,
      expiresAt,
      consumed: false,
    };

    this.challenges.set(nonce, record);
    this.logger.debug(
      `Issued wallet-link challenge for chain=${chain} expiresAt=${expiresAt.toISOString()}`,
    );

    return {
      nonce,
      userId,
      address: normalizedAddress,
      chain,
      operation,
      message,
      expiresAt,
    };
  }

  /**
   * Validates all challenge bindings, executes the synchronous signature
   * verification callback, and atomically marks the challenge as consumed.
   */
  verifyAndConsume(params: VerifyAndConsumeWalletLinkChallengeParams): void {
    const nonce = params.nonce?.trim();
    if (!nonce) {
      throw new BadRequestException('Wallet-link challenge nonce is required');
    }

    const record = this.challenges.get(nonce);
    if (!record) {
      this.logger.warn('Wallet-link challenge rejected [unknown]');
      throw new BadRequestException('Invalid or unknown wallet-link challenge');
    }

    if (record.consumed) {
      this.logger.warn('Wallet-link challenge rejected [replayed]');
      throw new BadRequestException(
        'Wallet-link challenge has already been used',
      );
    }

    if (record.expiresAt.getTime() <= Date.now()) {
      this.challenges.delete(nonce);
      this.logger.warn('Wallet-link challenge rejected [expired]');
      throw new BadRequestException('Wallet-link challenge has expired');
    }

    const userMatches = timingSafeEqualUtf8(record.userId, params.userId);
    const addressMatches = constantTimeAddressEqual(
      record.address,
      params.address,
    );
    const chainMatches = timingSafeEqualUtf8(record.chain, params.chain);
    const operationMatches = timingSafeEqualUtf8(
      record.operation,
      params.operation,
    );
    const messageMatches = timingSafeEqualUtf8(record.message, params.message);

    if (
      !userMatches ||
      !addressMatches ||
      !chainMatches ||
      !operationMatches ||
      !messageMatches
    ) {
      this.logger.warn('Wallet-link challenge rejected [binding-mismatch]');
      throw new BadRequestException('Wallet-link challenge binding mismatch');
    }

    // Verify cryptographic signature synchronously before consuming.
    params.verifySignature();

    // Mark consumed synchronously (no await between check and set).
    record.consumed = true;
  }

  pruneExpired(now = Date.now()): number {
    let removed = 0;
    for (const [nonce, record] of this.challenges.entries()) {
      if (record.expiresAt.getTime() <= now) {
        this.challenges.delete(nonce);
        removed += 1;
      }
    }
    return removed;
  }

  private normalizeAddress(address: string): string {
    try {
      return getAddress(address);
    } catch {
      throw new BadRequestException('Invalid EVM address');
    }
  }

  private formatMessage(fields: {
    operation: WalletLinkOperation;
    userId: string;
    address: string;
    chain: string;
    nonce: string;
    expiresAt: Date;
  }): string {
    return [
      'TruthBounty Wallet Link Challenge',
      `Operation: ${fields.operation}`,
      `Account: ${fields.userId}`,
      `Address: ${fields.address}`,
      `Chain: ${fields.chain}`,
      `Nonce: ${fields.nonce}`,
      `Expires At: ${fields.expiresAt.toISOString()}`,
    ].join('\n');
  }
}
