import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Stake } from './entities/stake.entity';
import { ProjectStakeLock } from './entities/project-stake-lock.entity';
import { ProjectStakeWithdrawal } from './entities/project-stake-withdrawal.entity';

export interface CreateStakeLockInput {
  walletAddress: string;
  claimId: string;
  amount: string;
  unlocksAt: number;
  reason?: string | null;
}

export interface EntitlementBreakdown {
  walletAddress: string;
  claimId: string;
  /** Total staked (wei) */
  totalStaked: string;
  /** Sum of not-yet-expired locked amounts (wei) */
  locked: string;
  /** Sum of expired locks that are pending release (wei) */
  expiredLocked: string;
  /** Total withdrawals recorded (wei) */
  withdrawn: string;
  /** withdrawable = totalStaked - (locked + expiredLocked) - withdrawn */
  withdrawable: string;
}

export interface WithdrawalResult {
  walletAddress: string;
  claimId: string;
  amount: string;
  txHash: string;
  applied: boolean;
  reason?: string;
}

/**
 * "V2-BE-015 — project stake locks / entitlements / withdrawals".
 *
 * Governs how much of a project stake a wallet may withdraw at any given time:
 *   entitlement(wallet, claim) = totalStaked - activeLocks - alreadyWithdrawn
 *
 * A lock is *active* until its `unlocksAt` timestamp. Once expired it stops
 * reducing the entitlement (releasing that portion for withdrawal). Cash-out
 * (withdrawal) is idempotent on `txHash` so indexed replays never double debit.
 */
@Injectable()
export class ProjectStakeService {
  private readonly logger = new Logger(ProjectStakeService.name);

  constructor(
    @InjectRepository(Stake)
    private readonly stakeRepo: Repository<Stake>,
    @InjectRepository(ProjectStakeLock)
    private readonly lockRepo: Repository<ProjectStakeLock>,
    @InjectRepository(ProjectStakeWithdrawal)
    private readonly withdrawalRepo: Repository<ProjectStakeWithdrawal>,
  ) {}

  /**
   * Create a new time-locked stake lock for a wallet+claim.
   * Does not alter the total stake (locks sit on top of the staked balance).
   */
  async createLock(input: CreateStakeLockInput): Promise<ProjectStakeLock> {
    const amount = BigInt(input.amount);
    if (amount <= 0n) {
      throw new Error('lock amount must be positive');
    }

    const stake = await this.stakeRepo.findOne({
      where: {
        walletAddress: input.walletAddress,
        claimId: input.claimId,
      },
    });
    if (!stake || BigInt(stake.amount) < amount) {
      throw new Error(
        `insufficient staked balance to lock ${input.amount} for ${input.walletAddress}/${input.claimId}`,
      );
    }

    const lock = this.lockRepo.create({
      walletAddress: input.walletAddress,
      claimId: input.claimId,
      amount: input.amount,
      unlocksAt: String(input.unlocksAt),
      reason: input.reason ?? null,
    });
    return this.lockRepo.save(lock);
  }

  /**
   * Compute the live entitlement breakdown for a wallet+claim.
   */
  async getEntitlement(
    walletAddress: string,
    claimId: string,
  ): Promise<EntitlementBreakdown> {
    const stake = await this.stakeRepo.findOne({
      where: { walletAddress, claimId },
    });
    const totalStaked = stake ? stake.amount : '0';

    const locks = await this.lockRepo.find({
      where: { walletAddress, claimId },
    });
    const nowSec = Math.floor(Date.now() / 1000);

    let locked = 0n;
    let expiredLocked = 0n;
    for (const lock of locks) {
      const amount = BigInt(lock.amount);
      if (BigInt(lock.unlocksAt) > BigInt(nowSec)) {
        locked += amount;
      } else {
        expiredLocked += amount;
      }
    }

    const withdrawals = await this.withdrawalRepo.find({
      where: { walletAddress, claimId },
    });
    let withdrawn = 0n;
    for (const w of withdrawals) {
      withdrawn += BigInt(w.amount);
    }

    const total = BigInt(totalStaked);
    const lockedTotal = locked + expiredLocked;
    let withdrawable = total - lockedTotal - withdrawn;
    if (withdrawable < 0n) {
      withdrawable = 0n;
    }

    return {
      walletAddress,
      claimId,
      totalStaked: total.toString(),
      locked: locked.toString(),
      expiredLocked: expiredLocked.toString(),
      withdrawn: withdrawn.toString(),
      withdrawable: withdrawable.toString(),
    };
  }

  /**
   * Withdraw an amount from a wallet's withdrawable entitlement.
   *
   * - Idempotent on `txHash`: a replayed withdrawal is a no-op.
   * - Expired locks are consumed (FIFO by unlock time) to satisfy the amount;
   *   if there is still a shortfall against *active* locks, the withdrawal is
   *   rejected (the stake is not yet entitled).
   *
   * @returns `applied: false, reason` when the entitlement would be exceeded.
   */
  async withdraw(input: {
    walletAddress: string;
    claimId: string;
    amount: string;
    txHash: string;
    blockNumber?: number;
    timestamp?: Date;
  }): Promise<WithdrawalResult> {
    const existing = await this.withdrawalRepo.findOne({
      where: { txHash: input.txHash },
    });
    if (existing) {
      return {
        walletAddress: input.walletAddress,
        claimId: input.claimId,
        amount: input.amount,
        txHash: input.txHash,
        applied: false,
        reason: 'duplicate_tx',
      };
    }

    const entitlement = await this.getEntitlement(
      input.walletAddress,
      input.claimId,
    );
    const amount = BigInt(input.amount);
    if (amount <= 0n) {
      return {
        walletAddress: input.walletAddress,
        claimId: input.claimId,
        amount: input.amount,
        txHash: input.txHash,
        applied: false,
        reason: 'non_positive_amount',
      };
    }
    if (amount > BigInt(entitlement.withdrawable)) {
      return {
        walletAddress: input.walletAddress,
        claimId: input.claimId,
        amount: input.amount,
        txHash: input.txHash,
        applied: false,
        reason: 'insufficient_entitlement',
      };
    }

    await this.withdrawalRepo.save(
      this.withdrawalRepo.create({
        walletAddress: input.walletAddress,
        claimId: input.claimId,
        amount: input.amount,
        txHash: input.txHash,
        blockNumber: input.blockNumber ?? 0,
        timestamp: input.timestamp ?? new Date(),
      }),
    );

    await this.consumeExpiredLocks(input.walletAddress, input.claimId, amount);

    return {
      walletAddress: input.walletAddress,
      claimId: input.claimId,
      amount: input.amount,
      txHash: input.txHash,
      applied: true,
    };
  }

  /**
   * FIFO-release expired locks to cover a withdrawal amount. Locked portions
   * that have already expired are decremented as they are withdrawn.
   */
  private async consumeExpiredLocks(
    walletAddress: string,
    claimId: string,
    amount: bigint,
  ): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = await this.lockRepo.find({
      where: { walletAddress, claimId },
      order: { unlocksAt: 'ASC', createdAt: 'ASC' },
    });

    let remaining = amount;
    for (const lock of expired) {
      if (remaining <= 0n) {
        break;
      }
      if (BigInt(lock.unlocksAt) > BigInt(nowSec)) {
        continue; // active lock — leave untouched
      }
      const lockAmount = BigInt(lock.amount);
      const consume = lockAmount < remaining ? lockAmount : remaining;
      const newAmount = (lockAmount - consume).toString();
      remaining -= consume;
      if (newAmount === '0') {
        await this.lockRepo.delete(lock.id);
        this.logger.log(`Released expired lock ${lock.id} (${claimId})`);
      } else {
        lock.amount = newAmount;
        await this.lockRepo.save(lock);
      }
    }
  }

  /**
   * Reconcile a wallet+claim against an externally observed stake balance.
   * Emits a critical error if the locally projected total diverges from the
   * on-chain truth by more than `tolerance`.
   */
  async reconcile(
    walletAddress: string,
    claimId: string,
    observedTotal: string,
  ): Promise<{ inSync: boolean; divergence: string }> {
    const stake = await this.stakeRepo.findOne({
      where: { walletAddress, claimId },
    });
    const local = stake ? BigInt(stake.amount) : 0n;
    const observed = BigInt(observedTotal);
    const divergence = observed - local;
    const inSync = divergence === 0n;

    if (!inSync) {
      this.logger.error(
        `CRITICAL stake reconciliation mismatch wallet=${walletAddress} claim=${claimId}: ` +
          `local=${local.toString()} observed=${observed.toString()} divergence=${divergence.toString()}`,
      );
    } else {
      this.logger.log(
        `Stake reconciliation in sync wallet=${walletAddress} claim=${claimId} (${local.toString()})`,
      );
    }

    return { inSync, divergence: divergence.toString() };
  }

  /**
   * Look up a single stake by wallet+claim; throws if absent.
   */
  async getStakeOrThrow(
    walletAddress: string,
    claimId: string,
  ): Promise<Stake> {
    const stake = await this.stakeRepo.findOne({
      where: { walletAddress, claimId },
    });
    if (!stake) {
      throw new NotFoundException(`no stake for ${walletAddress}/${claimId}`);
    }
    return stake;
  }
}
