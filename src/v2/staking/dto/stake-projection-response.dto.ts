import { ApiProperty } from '@nestjs/swagger';
import { DataState } from '../../common/data-state.enum';
import {
  CanonicalStakeState,
  ExactStakeBalances,
  LockPhase,
  LockStatus,
  PayoutStatus,
  ROUNDING_POLICY,
  SourceReference,
  StakeConservationResult,
  StakeLockItem,
  PayoutProjectionItem,
} from '../stake-projection.types';

export class AssetMetadataDto {
  @ApiProperty({ description: 'ERC20 contract address or 0x0 for native' })
  address!: string;

  @ApiProperty({ description: 'Token symbol' })
  symbol!: string;

  @ApiProperty({ description: 'Token decimals' })
  decimals!: number;

  @ApiProperty({ description: 'Token human-readable name' })
  name!: string;

  @ApiProperty({ description: 'EVM chain ID' })
  chainId!: number;
}

export class FinalityMetadataDto {
  @ApiProperty({ enum: DataState, description: 'Finality classification of the projection' })
  dataState!: DataState;

  @ApiProperty({ description: 'Number of block confirmations relative to finalized height' })
  confirmations!: number;

  @ApiProperty({ description: 'Latest block number contributing to this projection' })
  blockNumber!: string;

  @ApiProperty({ description: 'Current finalized block height', nullable: true })
  finalizedHeight!: string | null;

  @ApiProperty({ description: 'Current safe block height', nullable: true })
  safeHeight!: string | null;

  @ApiProperty({ description: 'Whether the projection is based purely on finalized blocks' })
  isFinalized!: boolean;

  @ApiProperty({
    description:
      'Projections are non-authoritative read models; authoritative truth resides on-chain',
    default: false,
  })
  isAuthoritative!: boolean;
}

export class ProvenanceMetadataDto {
  @ApiProperty({ description: 'Release version tag' })
  releaseVersion!: string;

  @ApiProperty({ description: 'Protocol version' })
  protocolVersion!: string;

  @ApiProperty({ description: 'ABI version' })
  abiVersion!: string;

  @ApiProperty({ description: 'EVM Chain ID' })
  chainId!: number;

  @ApiProperty({ description: 'Network identifier' })
  network!: string;

  @ApiProperty({ description: 'Release manifest checksum for integrity binding' })
  manifestChecksum!: string;

  @ApiProperty({ description: 'Authoritative contract address' })
  contractAddress!: string;

  @ApiProperty({ description: 'Block number at which the state was bound', required: false })
  projectionBlock?: string;
}

export class StakeBalancesDto implements ExactStakeBalances {
  @ApiProperty({ description: 'Total deposited stake in wei' })
  totalStaked!: string;

  @ApiProperty({ description: 'Available withdrawable balance in wei' })
  available!: string;

  @ApiProperty({ description: 'Active locked amount in wei' })
  locked!: string;

  @ApiProperty({ description: 'Expired locked amount pending unlock in wei' })
  expiredLocked!: string;

  @ApiProperty({ description: 'Pending or retryable withdrawals in wei' })
  pendingWithdrawal!: string;

  @ApiProperty({ description: 'Slashed stake amount in wei' })
  slashed!: string;

  @ApiProperty({ description: 'Settled withdrawn amount in wei' })
  withdrawn!: string;

  @ApiProperty({ description: 'Contract dust retained in wei' })
  dust!: string;
}

export class StakeConservationDto implements StakeConservationResult {
  @ApiProperty({ description: 'Whether the sum of balances strictly matches total deposited stake' })
  reconciled!: boolean;

  @ApiProperty({ description: 'Sum of allocated components in wei' })
  expectedTotal!: string;

  @ApiProperty({ description: 'Actual recorded funded stake in wei' })
  actualTotal!: string;

  @ApiProperty({ description: 'Delta between actual and expected (must be 0)' })
  delta!: string;

  @ApiProperty({ description: 'Deterministic SHA-256 conservation digest' })
  digest!: string;

  @ApiProperty({ description: 'Rounding policy used', default: ROUNDING_POLICY })
  roundingPolicy: typeof ROUNDING_POLICY = ROUNDING_POLICY;
}

export class StakeLockDto implements StakeLockItem {
  @ApiProperty({ description: 'Lock ID' })
  lockId!: string;

  @ApiProperty({ description: 'Associated claim ID' })
  claimId!: string;

  @ApiProperty({ description: 'Associated verification round ID', nullable: true })
  roundId?: string | null;

  @ApiProperty({ description: 'Wallet address of the staker' })
  walletAddress!: string;

  @ApiProperty({ description: 'Locked amount in wei' })
  amount!: string;

  @ApiProperty({ description: 'Unix timestamp when lock expires' })
  unlocksAt!: number;

  @ApiProperty({ description: 'Lock phase', required: false })
  phase?: LockPhase;

  @ApiProperty({ description: 'Lock status' })
  status!: LockStatus;

  @ApiProperty({ description: 'Reason for lock', nullable: true })
  reason?: string | null;

  @ApiProperty({ description: 'Whether lock carried over into an appeal round', required: false })
  isAppealCarry?: boolean;

  @ApiProperty({ description: 'Canonical event source reference', required: false })
  source?: SourceReference;
}

export class StakePayoutDto implements PayoutProjectionItem {
  @ApiProperty({ description: 'Payout ID' })
  payoutId!: string;

  @ApiProperty({ description: 'Claim ID' })
  claimId!: string;

  @ApiProperty({ description: 'Recipient wallet address' })
  walletAddress!: string;

  @ApiProperty({ description: 'Amount in wei' })
  amount!: string;

  @ApiProperty({ description: 'Payout status' })
  status!: PayoutStatus;

  @ApiProperty({ description: 'Whether the payout can be safely retried without double debit' })
  retryable!: boolean;

  @ApiProperty({ description: 'Failure reason if failed', nullable: true })
  failureReason?: string | null;

  @ApiProperty({ description: 'Number of retry attempts' })
  retryCount!: number;

  @ApiProperty({ description: 'On-chain transaction hash if submitted', nullable: true })
  txHash?: string | null;

  @ApiProperty({ description: 'Block number if mined', required: false })
  blockNumber?: number;

  @ApiProperty({ description: 'Creation ISO timestamp' })
  createdAt!: string;

  @ApiProperty({ description: 'Update ISO timestamp' })
  updatedAt!: string;

  @ApiProperty({ description: 'Canonical source reference', required: false })
  source?: SourceReference;
}

export class StakeProjectionResponseDto {
  @ApiProperty({ description: 'Wallet address of staker' })
  walletAddress!: string;

  @ApiProperty({ description: 'Claim ID if scoped to a claim', nullable: true })
  claimId?: string | null;

  @ApiProperty({ description: 'Canonical stake state' })
  stakeState!: CanonicalStakeState;

  @ApiProperty({ description: 'Whether projection is based on unfinalized block' })
  isEstimate!: boolean;

  @ApiProperty({ description: 'Whether the projection is legally authoritative (always false)' })
  isAuthoritative!: boolean;

  @ApiProperty({ description: 'Mandatory authority disclaimer' })
  authorityDisclaimer!: string;

  @ApiProperty({ type: StakeBalancesDto, description: 'Exact 256-bit balance breakdown' })
  balances!: StakeBalancesDto;

  @ApiProperty({ type: StakeConservationDto, description: 'Custody conservation verification' })
  conservation!: StakeConservationDto;

  @ApiProperty({ type: [StakeLockDto], description: 'Detailed round locks and time locks' })
  locks!: StakeLockDto[];

  @ApiProperty({ type: [StakePayoutDto], description: 'Payouts and retryable withdrawals' })
  payouts!: StakePayoutDto[];

  @ApiProperty({ type: AssetMetadataDto, description: 'Token metadata' })
  asset!: AssetMetadataDto;

  @ApiProperty({ type: FinalityMetadataDto, description: 'Block finality metadata' })
  finality!: FinalityMetadataDto;

  @ApiProperty({ type: ProvenanceMetadataDto, description: 'Chain and release provenance binding' })
  provenance!: ProvenanceMetadataDto;

  @ApiProperty({ description: 'ISO 8601 timestamp of projection generation' })
  projectionsGeneratedAt!: string;
}
