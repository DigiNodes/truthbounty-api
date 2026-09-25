import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { ModuleRef } from '@nestjs/core';
import { DataSource, EntityManager } from 'typeorm';
import { CanonicalEvent } from './entities/canonical-event.entity';
import { EventCheckpoint } from './entities/event-checkpoint.entity';
import { EventQuarantine } from './entities/event-quarantine.entity';
import { ProjectorCursor } from '../common/entities/projector-cursor.entity';
import {
  IndexingAnomaly,
  IndexingAnomalyKind,
} from '../common/entities/indexing-anomaly.entity';
import {
  ProjectEvidence,
  EvidenceStatus,
} from '../evidence/entities/project-evidence.entity';
import { ProjectEvidenceVersion } from '../evidence/entities/project-evidence-version.entity';
import { ProjectVerificationRound } from '../verification/entities/project-verification-round.entity';
import { ProjectParticipantPosition } from '../verification/entities/project-participant-position.entity';
import {
  ProjectDispute,
  DisputeStatus,
} from '../disputes/entities/project-dispute.entity';
import { CanonicalEventsService } from './canonical-events.service';
import { RawLog } from './interfaces/canonical-event.interface';
import {
  IV2Projector,
  ReorgRollbackResult,
  CanonicalReapplicationResult,
  ReorgExecutionResult,
  ReorgOptions,
  AffectedReadModels,
} from './interfaces/reorg-rollback.interface';
import { EvidenceProjectorService } from '../evidence/evidence-projector.service';
import { VerificationProjectorService } from '../verification/verification-projector.service';
import { DisputesProjectorService } from '../disputes/disputes-projector.service';

@Injectable()
export class ReorgRollbackService {
  private readonly logger = new Logger(ReorgRollbackService.name);
  private readonly registeredProjectors = new Map<string, IV2Projector>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly canonicalEventsService: CanonicalEventsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Register a custom projector for reapplication and replay coordination.
   */
  registerProjector(name: string, projector: IV2Projector): void {
    this.registeredProjectors.set(name, projector);
  }

  /**
   * Validate parameters fail-closed: chainId must be a positive integer,
   * rollbackToBlock must be non-negative.
   */
  private validateRollbackInput(
    chainId: number,
    rollbackToBlock: bigint | string | number,
  ): bigint {
    if (!Number.isInteger(chainId) || chainId <= 0) {
      throw new BadRequestException(
        `Invalid chainId ${chainId}: must be a positive integer`,
      );
    }

    try {
      const block = BigInt(rollbackToBlock);
      if (block < 0n) {
        throw new BadRequestException(
          `Invalid rollbackToBlock ${rollbackToBlock}: must be non-negative`,
        );
      }
      return block;
    } catch {
      throw new BadRequestException(
        `Invalid rollbackToBlock value: ${rollbackToBlock}`,
      );
    }
  }

  /**
   * Roll back canonical events, checkpoints, projector cursors, and read models
   * to a specified safe block height following a chain reorganization.
   *
   * Executes atomically within a database transaction.
   */
  async rollback(
    chainId: number,
    rollbackToBlockInput: bigint | string | number,
    contractAddress?: string,
  ): Promise<ReorgRollbackResult> {
    const rollbackToBlock = this.validateRollbackInput(
      chainId,
      rollbackToBlockInput,
    );
    const rollbackBlockStr = rollbackToBlock.toString();

    this.logger.warn(
      `Executing reorg rollback on chain ${chainId} to block ${rollbackBlockStr}${
        contractAddress ? ` for contract ${contractAddress}` : ''
      }`,
    );

    return this.dataSource.transaction(async (manager: EntityManager) => {
      // 1. Identify all canonical events to purge (blockNumber > rollbackToBlock)
      const eventQb = manager
        .getRepository(CanonicalEvent)
        .createQueryBuilder('e')
        .where('e.chainId = :chainId', { chainId })
        .andWhere('CAST(e.blockNumber AS NUMERIC) > :rollbackToBlock', {
          rollbackToBlock: rollbackBlockStr,
        });

      if (contractAddress) {
        eventQb.andWhere('LOWER(e.contractAddress) = :contractAddress', {
          contractAddress: contractAddress.toLowerCase(),
        });
      }

      const orphanedEvents = await eventQb.getMany();
      const orphanedTxHashes = Array.from(
        new Set(orphanedEvents.map((e) => e.txHash)),
      );

      const affectedReadModels: AffectedReadModels = {
        evidenceVersionsRemoved: 0,
        evidenceUpdated: 0,
        evidenceRemoved: 0,
        verificationRoundsRemoved: 0,
        participantPositionsRemoved: 0,
        disputesReverted: 0,
        disputesRemoved: 0,
        anomaliesRemoved: 0,
      };

      // 2. Roll back downstream read models
      if (orphanedEvents.length > 0) {
        await this.rollbackReadModels(
          manager,
          rollbackToBlock,
          orphanedTxHashes,
          affectedReadModels,
        );
      }

      // 3. Purge orphaned canonical events
      let purgedEventsCount = 0;
      if (orphanedEvents.length > 0) {
        const deleteResult = await eventQb.delete().execute();
        purgedEventsCount = deleteResult.affected ?? orphanedEvents.length;
      }

      // 4. Purge orphaned quarantined events
      const quarantineQb = manager
        .getRepository(EventQuarantine)
        .createQueryBuilder('q')
        .delete()
        .where('q.chainId = :chainId', { chainId })
        .andWhere('CAST(q.blockNumber AS NUMERIC) > :rollbackToBlock', {
          rollbackToBlock: rollbackBlockStr,
        });
      if (contractAddress) {
        quarantineQb.andWhere('LOWER(q.contractAddress) = :contractAddress', {
          contractAddress: contractAddress.toLowerCase(),
        });
      }
      const quarantineDeleteResult = await quarantineQb.execute();
      const purgedQuarantinesCount = quarantineDeleteResult.affected ?? 0;

      // 5. Adjust EventCheckpoint records
      const checkpointRepo = manager.getRepository(EventCheckpoint);
      const checkpointQb = checkpointRepo
        .createQueryBuilder('c')
        .where('c.chainId = :chainId', { chainId });
      if (contractAddress) {
        checkpointQb.andWhere('LOWER(c.contractAddress) = :contractAddress', {
          contractAddress: contractAddress.toLowerCase(),
        });
      }
      const checkpoints = await checkpointQb.getMany();
      let checkpointsUpdated = 0;

      for (const cp of checkpoints) {
        let changed = false;
        if (BigInt(cp.lastSafeBlock) > rollbackToBlock) {
          cp.lastSafeBlock = rollbackBlockStr;
          changed = true;
        }
        if (BigInt(cp.lastFinalizedBlock) > rollbackToBlock) {
          cp.lastFinalizedBlock = rollbackBlockStr;
          changed = true;
        }
        if (changed) {
          await checkpointRepo.save(cp);
          checkpointsUpdated++;
        }
      }

      // 6. Rewind Projector Cursors
      const cursorRepo = manager.getRepository(ProjectorCursor);
      const cursors = await cursorRepo.find();
      const rewoundCursors: string[] = [];

      // Find the max logIndex among canonical events at rollbackToBlock, if any
      const maxLogIndexAtRollbackBlockResult = await manager
        .getRepository(CanonicalEvent)
        .createQueryBuilder('e')
        .select('MAX(e.logIndex)', 'maxLog')
        .where('e.chainId = :chainId', { chainId })
        .andWhere('CAST(e.blockNumber AS NUMERIC) = :rollbackToBlock', {
          rollbackToBlock: rollbackBlockStr,
        })
        .getRawOne();

      const lastLogIndexAtRollback =
        maxLogIndexAtRollbackBlockResult &&
        maxLogIndexAtRollbackBlockResult.maxLog !== null
          ? Number(maxLogIndexAtRollbackBlockResult.maxLog)
          : -1;

      for (const cursor of cursors) {
        if (BigInt(cursor.lastBlockNumber) > rollbackToBlock) {
          cursor.lastBlockNumber = rollbackBlockStr;
          cursor.lastLogIndex = lastLogIndexAtRollback;
          await cursorRepo.save(cursor);
          rewoundCursors.push(cursor.projectorName);
        }
      }

      this.logger.log(
        `Rollback completed: ${purgedEventsCount} canonical events purged, ` +
          `${checkpointsUpdated} checkpoints updated, ${rewoundCursors.length} cursors rewound.`,
      );

      return {
        chainId,
        rollbackToBlock: rollbackBlockStr,
        purgedEventsCount,
        purgedQuarantinesCount,
        checkpointsUpdated,
        rewoundCursors,
        affectedReadModels,
      };
    });
  }

  /**
   * Helper to roll back read models across all V2 projector schemas.
   */
  private async rollbackReadModels(
    manager: EntityManager,
    rollbackToBlock: bigint,
    orphanedTxHashes: string[],
    affected: AffectedReadModels,
  ): Promise<void> {
    const rollbackBlockStr = rollbackToBlock.toString();

    // A. Evidence and Versions
    const versionRepo = manager.getRepository(ProjectEvidenceVersion);
    const evidenceRepo = manager.getRepository(ProjectEvidence);

    const orphanedVersions = await versionRepo
      .createQueryBuilder('v')
      .where('CAST(v.blockNumber AS NUMERIC) > :rollbackToBlock', {
        rollbackToBlock: rollbackBlockStr,
      })
      .getMany();

    if (orphanedVersions.length > 0) {
      const affectedEvidenceIds = Array.from(
        new Set(orphanedVersions.map((v) => v.evidenceId)),
      );

      const delVersions = await versionRepo
        .createQueryBuilder('v')
        .delete()
        .where('CAST(v.blockNumber AS NUMERIC) > :rollbackToBlock', {
          rollbackToBlock: rollbackBlockStr,
        })
        .execute();
      affected.evidenceVersionsRemoved =
        delVersions.affected ?? orphanedVersions.length;

      // Restore or delete corresponding ProjectEvidence summaries
      for (const evidenceId of affectedEvidenceIds) {
        const remainingVersions = await versionRepo.find({
          where: { evidenceId },
          order: { version: 'DESC' },
        });

        if (remainingVersions.length === 0) {
          await evidenceRepo.delete({ evidenceId });
          affected.evidenceRemoved++;
        } else {
          const latest = remainingVersions[0];
          await evidenceRepo.update(
            { evidenceId },
            {
              currentVersion: latest.version,
              contentDigest: latest.contentDigest,
              lastEventBlockNumber: latest.blockNumber,
              lastEventLogIndex: latest.eventLogIndex,
              status: EvidenceStatus.ACTIVE,
            },
          );
          affected.evidenceUpdated++;
        }
      }
    }

    // B. Participant Positions
    const posDelete = await manager
      .getRepository(ProjectParticipantPosition)
      .createQueryBuilder('p')
      .delete()
      .where('CAST(p.blockNumber AS NUMERIC) > :rollbackToBlock', {
        rollbackToBlock: rollbackBlockStr,
      })
      .execute();
    affected.participantPositionsRemoved = posDelete.affected ?? 0;

    // C. Verification Rounds
    const roundDelete = await manager
      .getRepository(ProjectVerificationRound)
      .createQueryBuilder('r')
      .delete()
      .where('CAST(r.openedAtBlock AS NUMERIC) > :rollbackToBlock', {
        rollbackToBlock: rollbackBlockStr,
      })
      .execute();
    affected.verificationRoundsRemoved = roundDelete.affected ?? 0;

    // D. Disputes
    const disputeRepo = manager.getRepository(ProjectDispute);
    const disputes = await disputeRepo.find();

    for (const dispute of disputes) {
      if (orphanedTxHashes.includes(dispute.eventTxHash)) {
        // Look for the raising event among remaining safe canonical events
        const raiseEvent = await manager
          .getRepository(CanonicalEvent)
          .createQueryBuilder('e')
          .where('e.eventName = :name', { name: 'DisputeRaised' })
          .andWhere('e.claimId = :claimId', { claimId: dispute.claimId })
          .andWhere('e.roundId = :roundId', {
            roundId: dispute.originalRoundId,
          })
          .andWhere('CAST(e.blockNumber AS NUMERIC) <= :rollbackToBlock', {
            rollbackToBlock: rollbackBlockStr,
          })
          .getOne();

        if (!raiseEvent) {
          // Raising event was in the rolled-back block -> delete dispute
          await disputeRepo.delete({ disputeId: dispute.disputeId });
          affected.disputesRemoved++;
        } else {
          // Dispute was raised in a valid block, but resolved/expired in an orphaned block
          dispute.status = DisputeStatus.RAISED;
          dispute.resolvedOutcome = null;
          dispute.eventTxHash = raiseEvent.txHash;
          dispute.eventLogIndex = raiseEvent.logIndex;
          await disputeRepo.save(dispute);
          affected.disputesReverted++;
        }
      }
    }

    // E. Indexing Anomalies
    if (orphanedTxHashes.length > 0) {
      const anomalyDelete = await manager
        .getRepository(IndexingAnomaly)
        .createQueryBuilder('a')
        .delete()
        .where('a.eventTxHash IN (:...txHashes)', {
          txHashes: orphanedTxHashes,
        })
        .execute();
      affected.anomaliesRemoved = anomalyDelete.affected ?? 0;
    }
  }

  /**
   * Reapply canonical EVM raw logs in deterministic protocol order and
   * re-trigger projectors to advance read models to current canonical tip.
   */
  async reapplyLogs(logs: RawLog[]): Promise<CanonicalReapplicationResult> {
    if (!logs || logs.length === 0) {
      const projectorSummaries = await this.reapplyProjectors();
      return {
        logsProcessed: 0,
        ingestedCount: 0,
        duplicateCount: 0,
        quarantinedCount: 0,
        projectorSummaries,
      };
    }

    // Sort logs deterministically: (blockNumber ASC, logIndex ASC)
    const sortedLogs = [...logs].sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber < b.blockNumber ? -1 : 1;
      }
      return a.logIndex - b.logIndex;
    });

    let ingestedCount = 0;
    let duplicateCount = 0;
    let quarantinedCount = 0;

    for (const log of sortedLogs) {
      const outcome = await this.canonicalEventsService.ingest(log);
      if (outcome.status === 'ingested') ingestedCount++;
      else if (outcome.status === 'duplicate') duplicateCount++;
      else if (outcome.status === 'quarantined') quarantinedCount++;
    }

    const projectorSummaries = await this.reapplyProjectors();

    return {
      logsProcessed: sortedLogs.length,
      ingestedCount,
      duplicateCount,
      quarantinedCount,
      projectorSummaries,
    };
  }

  /**
   * Run all known V2 projectors until they have consumed all available canonical events.
   */
  async reapplyProjectors(
    batchSize = 100,
  ): Promise<
    Record<
      string,
      {
        processed: number;
        applied: number;
        anomalies?: number;
        duplicates?: number;
      }
    >
  > {
    const projectors = this.resolveProjectors();
    const summaries: Record<
      string,
      {
        processed: number;
        applied: number;
        anomalies?: number;
        duplicates?: number;
      }
    > = {};

    for (const [name, projector] of projectors.entries()) {
      let totalProcessed = 0;
      let totalApplied = 0;
      let totalAnomalies = 0;
      let totalDuplicates = 0;

      // Drain projector until no more new events
      let hasMore = true;
      while (hasMore) {
        const runSummary = await projector.processNewEvents(batchSize);
        totalProcessed += runSummary.processed;
        totalApplied += runSummary.applied;
        if (runSummary.anomalies) totalAnomalies += runSummary.anomalies;
        if (runSummary.duplicates) totalDuplicates += runSummary.duplicates;

        if (runSummary.processed < batchSize) {
          hasMore = false;
        }
      }

      summaries[name] = {
        processed: totalProcessed,
        applied: totalApplied,
        anomalies: totalAnomalies,
        duplicates: totalDuplicates,
      };
    }

    return summaries;
  }

  /**
   * Coordinates a complete reorg rollback and canonical reapplication cycle.
   */
  async handleReorg(options: ReorgOptions): Promise<ReorgExecutionResult> {
    const rollback = await this.rollback(
      options.chainId,
      options.rollbackToBlock,
      options.contractAddress,
    );

    const reapplication = await this.reapplyLogs(options.newLogs ?? []);

    return { rollback, reapplication };
  }

  /**
   * Rebuilds all projections from genesis (block 0) by resetting cursors and
   * replaying canonical events.
   */
  async rebuildAllProjections(
    batchSize = 100,
  ): Promise<
    Record<
      string,
      {
        processed: number;
        applied: number;
        anomalies?: number;
        duplicates?: number;
      }
    >
  > {
    this.logger.warn('Rebuilding all V2 projections from genesis...');

    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(ProjectorCursor).delete({});
      await manager.getRepository(ProjectEvidenceVersion).delete({});
      await manager.getRepository(ProjectEvidence).delete({});
      await manager.getRepository(ProjectParticipantPosition).delete({});
      await manager.getRepository(ProjectVerificationRound).delete({});
      await manager.getRepository(ProjectDispute).delete({});
      await manager.getRepository(IndexingAnomaly).delete({});
    });

    return this.reapplyProjectors(batchSize);
  }

  /**
   * Discovers and resolves all available V2 projectors.
   */
  private resolveProjectors(): Map<string, IV2Projector> {
    const map = new Map<string, IV2Projector>(this.registeredProjectors);

    // Try resolving default V2 projectors via ModuleRef if not explicitly registered
    if (!map.has('v2-evidence')) {
      try {
        const evidenceProj = this.moduleRef.get(EvidenceProjectorService, {
          strict: false,
        });
        if (evidenceProj) map.set('v2-evidence', evidenceProj);
      } catch {
        // Optional resolution
      }
    }

    if (!map.has('v2-verification')) {
      try {
        const verificationProj = this.moduleRef.get(
          VerificationProjectorService,
          { strict: false },
        );
        if (verificationProj) map.set('v2-verification', verificationProj);
      } catch {
        // Optional resolution
      }
    }

    if (!map.has('v2-disputes')) {
      try {
        const disputesProj = this.moduleRef.get(DisputesProjectorService, {
          strict: false,
        });
        if (disputesProj) map.set('v2-disputes', disputesProj);
      } catch {
        // Optional resolution
      }
    }

    return map;
  }
}
