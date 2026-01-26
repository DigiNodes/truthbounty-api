import { Injectable } from "@nestjs/common";
import { Repository } from "typeorm"; // Import Repository from typeorm
import { StakeEvent } from "./entities/stake-event.entity";
import { StakingEventType } from "./types/staking-event.type";
import { Stake } from "./entities/stake.entity";

@Injectable()
export class StakingSyncService {
  constructor(
    private readonly stakeRepo: Repository<Stake>,
    private readonly stakeEventRepo: Repository<StakeEvent>,
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
    // 1️⃣ Store audit event (idempotent)
    await this.stakeEventRepo.upsert(
      {
        ...event,
      },
      ['txHash'],
    );

    // 2️⃣ Fetch current stake
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

    // 3️⃣ Apply delta
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
}
