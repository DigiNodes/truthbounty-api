import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { StakeEvent } from './entities/stake-event.entity';
import { StakingEventType } from './types/staking-event.type';
import { Stake } from './entities/stake.entity';
import {
  STAKING_AUTHORITY_CONFIG_KEYS,
} from '../sybil-resistance/sybil-staking-authority.service';

@Injectable()
export class StakingSyncService {
  constructor(
    private readonly stakeRepo: Repository<Stake>,
    private readonly stakeEventRepo: Repository<StakeEvent>,
    private readonly configService: ConfigService,
  ) {}

  async handleEvent(event: {
    type: StakingEventType;
    walletAddress: string;
    claimId: string;
    amount: string;
    txHash: string;
    blockNumber: number;
    timestamp: Date;
  }) {
    const chainId = this.readPositiveInt(
      STAKING_AUTHORITY_CONFIG_KEYS.chainId,
    );
    const contractAddress = this.readAddress(
      STAKING_AUTHORITY_CONFIG_KEYS.contractAddress,
    );

    await this.stakeEventRepo.upsert(
      {
        ...event,
        chainId,
        contractAddress,
      },
      ['txHash'],
    );

    let stake = await this.stakeRepo.findOne({
      where: {
        walletAddress: event.walletAddress,
        claimId: event.claimId,
      },
    });

    if (!stake) {
      stake = this.stakeRepo.create({
        walletAddress: event.walletAddress,
        claimId: event.claimId,
        amount: '0',
      });
    }

    const current = BigInt(stake.amount);
    const delta = BigInt(event.amount);

    switch (event.type) {
      case StakingEventType.STAKE_DEPOSITED:
        stake.amount = (current + delta).toString();
        break;

      case StakingEventType.STAKE_WITHDRAWN:
      case StakingEventType.STAKE_SLASHED:
        stake.amount = (current - delta).toString();
        break;
    }

    stake.lastTxHash = event.txHash;
    stake.updatedAt = new Date();

    await this.stakeRepo.save(stake);
  }

  private readPositiveInt(keys: readonly string[]): number | null {
    for (const key of keys) {
      const raw = this.configService.get<string | number>(key);
      if (raw === undefined || raw === null || `${raw}`.trim() === '') continue;
      const value = Number(raw);
      return Number.isSafeInteger(value) && value > 0 ? value : null;
    }
    return null;
  }

  private readAddress(keys: readonly string[]): string | null {
    for (const key of keys) {
      const raw = this.configService.get<string>(key);
      if (raw && /^0x[a-fA-F0-9]{40}$/.test(raw)) return raw;
    }
    return null;
  }
}
