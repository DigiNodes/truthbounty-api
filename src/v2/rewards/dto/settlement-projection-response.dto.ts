import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DataState } from '../../common/data-state.enum';
import { AllocationKind } from '../reward-allocation-kind.enum';
import {
  CanonicalSettlementState,
  CANONICAL_SETTLEMENT_STATES,
  ROUNDING_POLICY,
} from '../settlement-projection.types';

export class AssetMetadataDto {
  @ApiProperty({ description: 'ERC20 contract address of the reward/settlement asset' })
  address: string;

  @ApiProperty({ description: 'Token symbol (e.g. TRUTH)' })
  symbol: string;

  @ApiProperty({ description: 'Token decimals (standard 18)' })
  decimals: number;

  @ApiProperty({ description: 'Token human-readable name' })
  name: string;

  @ApiProperty({ description: 'EVM Chain ID' })
  chainId: number;
}

export class FinalityMetadataDto {
  @ApiProperty({
    description: 'Data state classification',
    enum: DataState,
  })
  dataState: DataState;

  @ApiProperty({ description: 'Observed block confirmations' })
  confirmations: number;

  @ApiProperty({ description: 'Latest block number contributing to projection' })
  blockNumber: string;

  @ApiPropertyOptional({ description: 'Latest known finalized block height' })
  finalizedHeight: string | null;

  @ApiPropertyOptional({ description: 'Latest known safe block height' })
  safeHeight: string | null;

  @ApiProperty({ description: 'Whether the projection has reached finality' })
  isFinalized: boolean;

  @ApiProperty({
    description:
      'Whether this state is protocol-authoritative. Always false for API estimates; true only when finalized on-chain.',
  })
  isAuthoritative: boolean;
}

export class ProvenanceMetadataDto {
  @ApiProperty({ description: 'Release version binding (e.g. v2.0.0-sepolia)' })
  releaseVersion: string;

  @ApiProperty({ description: 'Protocol version' })
  protocolVersion: string;

  @ApiProperty({ description: 'ABI version' })
  abiVersion: string;

  @ApiProperty({ description: 'Target network Chain ID' })
  chainId: number;

  @ApiProperty({ description: 'Target network slug' })
  network: string;

  @ApiProperty({ description: 'Deterministic manifest checksum binding artifact release' })
  manifestChecksum: string;

  @ApiPropertyOptional({ description: 'Contract address if bound to specific settlement contract' })
  contractAddress?: string;

  @ApiPropertyOptional({ description: 'Settlement block number if settled' })
  settlementBlock?: string;
}

export class ExactSettlementValuesDto {
  @ApiProperty({ description: 'Total funded allocation amount (exact integer string in wei)' })
  funded: string;

  @ApiProperty({ description: 'Total accrued/allocated rewards across beneficiaries' })
  accrued: string;

  @ApiProperty({ description: 'Total claimed/paid amounts withdrawn by beneficiaries' })
  claimed: string;

  @ApiProperty({ description: 'Total claimable amounts currently available for withdrawal' })
  claimable: string;

  @ApiProperty({ description: 'Total pending amounts awaiting finality or challenge window' })
  pending: string;

  @ApiProperty({ description: 'Total slashed/forfeited amounts' })
  slashed: string;

  @ApiProperty({ description: 'Total refunded amounts (bonds/stakes returned)' })
  refunded: string;

  @ApiProperty({ description: 'Retained dust remainder resulting from integer division rounding' })
  dust: string;
}

export class ConservationReconciliationDto {
  @ApiProperty({
    description: 'Whether custody conservation reconciles: funded == claimed + claimable + pending + slashed + dust',
  })
  reconciled: boolean;

  @ApiProperty({ description: 'Expected funded amount (sum of claimed, claimable, pending, slashed, dust)' })
  expectedFunded: string;

  @ApiProperty({ description: 'Observed funded amount from pool' })
  actualFunded: string;

  @ApiProperty({ description: 'Unexplained delta (actualFunded - expectedFunded; must be 0 when reconciled)' })
  delta: string;

  @ApiProperty({ description: 'Explicit rounding policy applied', example: ROUNDING_POLICY })
  roundingPolicy: string;
}

export class AllocationProjectionDetailDto {
  @ApiProperty({ description: 'Allocation UUID or deterministic identity' })
  allocationId: string;

  @ApiProperty({ description: 'Beneficiary class', enum: AllocationKind })
  kind: AllocationKind;

  @ApiPropertyOptional({ description: 'Beneficiary wallet address, or null for treasury sink' })
  beneficiary: string | null;

  @ApiProperty({ description: 'Contract-allocated amount' })
  allocated: string;

  @ApiProperty({ description: 'Amounts claimed so far' })
  claimed: string;

  @ApiProperty({ description: 'Amounts claimable now' })
  claimable: string;

  @ApiProperty({ description: 'Amounts pending settlement/finality' })
  pending: string;

  @ApiProperty({
    description: 'Allocation status',
    enum: ['allocated', 'partially_claimed', 'claimed', 'over_claimed'],
  })
  status: string;
}

export class SettlementProjectionResponseDto {
  @ApiProperty({ description: 'Claim UUID' })
  claimId: string;

  @ApiProperty({
    description: 'Canonical settlement state',
    enum: CANONICAL_SETTLEMENT_STATES,
  })
  settlementState: CanonicalSettlementState;

  @ApiProperty({ description: 'Whether this read-model contains unfinalized estimates' })
  isEstimate: boolean;

  @ApiProperty({
    description:
      'Whether this API projection is authoritative. Always false: canonical finalized contract events are authoritative.',
  })
  isAuthoritative: boolean;

  @ApiProperty({
    description: 'Required authority disclaimer for non-authoritative API estimates',
    example:
      'Canonical finalized contract events remain authoritative. API projections are informational and non-authoritative.',
  })
  authorityDisclaimer: string;

  @ApiProperty({ description: 'Exact 256-bit integer settlement accounting values', type: ExactSettlementValuesDto })
  values: ExactSettlementValuesDto;

  @ApiProperty({ description: 'Conservation reconciliation status', type: ConservationReconciliationDto })
  conservation: ConservationReconciliationDto;

  @ApiProperty({ description: 'Asset metadata for the settled token', type: AssetMetadataDto })
  asset: AssetMetadataDto;

  @ApiProperty({ description: 'Finality metadata', type: FinalityMetadataDto })
  finality: FinalityMetadataDto;

  @ApiProperty({ description: 'Release and chain provenance binding', type: ProvenanceMetadataDto })
  provenance: ProvenanceMetadataDto;

  @ApiProperty({
    description: 'Itemized allocations breakdown by beneficiary',
    type: [AllocationProjectionDetailDto],
  })
  allocations: AllocationProjectionDetailDto[];

  @ApiProperty({ description: 'ISO 8601 timestamp when projection was computed' })
  projectionsGeneratedAt: string;
}
