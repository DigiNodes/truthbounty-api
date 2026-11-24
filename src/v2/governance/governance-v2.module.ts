import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GovernanceProposal } from './entities/governance-proposal.entity';
import { GovernanceAction } from './entities/governance-action.entity';
import { ProposalVote } from './entities/proposal-vote.entity';
import { RoleChange } from './entities/role-change.entity';
import { CanonicalEvent } from '../events/entities/canonical-event.entity';

import { ProposalDecoderService } from './proposal-decoder.service';
import { GovernanceProjectionService } from './governance-projection.service';
import { GovernanceReadService } from './governance-read.service';
import { GovernanceReadController } from './governance-read.controller';

import { ArtifactRegistryService } from '../events/artifact-registry.service';
import { ContractArtifact } from '../events/entities/contract-artifact.entity';

/**
 * GovernanceV2Module — V2-BE-067
 *
 * Read-only governance surface. Registers:
 *   - The 4 governance read-model entities (proposals, actions, votes,
 *     role changes).
 *   - ProposalDecoderService (fail-closed call decoding).
 *   - GovernanceProjectionService (event → read-model projection, reorg
 *     reconciliation).
 *   - GovernanceReadService (query side).
 *   - GovernanceReadController (HTTP surface under /v2/governance).
 *
 * Smart contracts remain authoritative for all governance mutations. This
 * module never writes to chain and never accepts user-triggered state
 * transitions.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      GovernanceProposal,
      GovernanceAction,
      ProposalVote,
      RoleChange,
      CanonicalEvent,
      ContractArtifact,
    ]),
  ],
  controllers: [GovernanceReadController],
  providers: [
    ArtifactRegistryService,
    ProposalDecoderService,
    GovernanceProjectionService,
    GovernanceReadService,
  ],
  exports: [GovernanceReadService, GovernanceProjectionService],
})
export class GovernanceV2Module {}
