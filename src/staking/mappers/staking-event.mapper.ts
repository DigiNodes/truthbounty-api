import { StakingEventType } from '../types/staking-event.type';

export function mapContractEventName(
  eventName: string,
): StakingEventType | null {
  switch (eventName) {
    case 'StakeDeposited':
      return StakingEventType.STAKE_DEPOSITED;
    case 'StakeWithdrawn':
      return StakingEventType.STAKE_WITHDRAWN;
    case 'StakeSlashed':
      return StakingEventType.STAKE_SLASHED;
    default:
      return null;
  }
}
