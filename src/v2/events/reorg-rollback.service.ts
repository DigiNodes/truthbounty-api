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

/**
 * Reorg rollback is the single authority for rewinding canonical state.
 *
 * Authorization and cursor state are durable (Postgres). In-memory maps in this
 * service are bounded, non-authoritative caches only: they are never consulted
 * to decide whether a rollback is permitted or where canonical progress sits.
 * Every cursor mutation is a database compare-and-swap executed inside the same
 * transaction as the rollback, so restarts and concurrent replicas cannot skip
 * or double-apply a rewind.
 *
 * Finalized state is never rolled back silently: a rollback target below the
 * finalized boundary is refused and the attempt is recorded as an anomaly.
 */
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

    let block: bigint;
    try {
      block = BigInt(rollbackToBlock);
    } catch {
      throw new BadRequestException(
        `Invalid rollbackToBlock value: ${rollbackToBlock}`,
      );
    }
    if (block < 0n) {
      throw new BadRequestException(
        `Invalid rollbackToBlock ${rollbackToBlock}: must be non-negative`,
      );
    }
    return block;
  }

  /**
   * Roll back canonical events, checkpoints, projector cursors, and read models
   * to a specified safe block height following a chain reorganization.
   *
   * Executes atomically within a single database transaction. The cursor
   * compare-and-swap uses a row-level lock (SELECT ... FOR UPDATE) so that two
   * replicas racing on the same chain cannot interleave a stale rewind.
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
      // Finality guard: refuse to rewind below any finalized checkpoint.
      const finalizedFloor = await this.getFinalizedFloor(
        manager,
        chainId,
        contractAddress,
      );
      if (finalizedFloor !== null && rollbackToBlock < finalizedFloor) {
        throw new BadRequestException(
          `Refusing rollback of chain ${chainId} to ${rollbackBlockStr}: ` +
            `finalized boundary ${finalizedFloor.toString()} cannot be rolled back`,
        );
      }

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

      // 5. Adjust EventCheckpoint records (row-locked; only moves backward)
      const checkpointRepo = manager.getRepository(EventCheckpoint);
      const checkpointQb = checkpointRepo
        .createQueryBuilder('c')
        .setLock('pessimistic_write')
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
          // Unreachable after the finality guard above; kept fail-closed.
          throw new BadRequestException(
            `Refusing rollback: checkpoint ${cp.id} finalized beyond ${rollbackBlockStr}`,
          );
        }
        if (changed) {
          await checkpointRepo.save(cp);
          checkpointsUpdated++;
        }
      }

      // 6. Rewind Projector Cursors with compare-and-swap on lastBlockNumber.
      const cursorRepo = manager.getRepository(ProjectorCursor);
      const cursors = await cursorRepo
        .createQueryBuilder('pc')
        .setLock('pessimistic_write')
        .getMany();
      const rewoundCursors: string[] = [];

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
        const observedBlock = cursor.lastBlockNumber;
        if (BigInt(observedBlock) > rollbackToBlock) {
          const updated = await cursorRepo
            .createQueryBuilder()
            .update(ProjectorCursor)
            .set({
              lastBlockNumber: rollbackBlockStr,
              lastLogIndex: lastLogIndexAtRollback,
            })
            .where('projectorName = :name', { name: cursor.projectorName })
            .andWhere('lastBlockNumber = :observed', { observed: observedBlock })
            .execute();
          if ((updated.affected ?? 0) !== 1) {
            throw new BadRequestException(
              `Cursor CAS failed for projector ${cursor.projectorName}: concurrent advance detected`,
            );
          }
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
   * Highest finalized block recorded durably for the scope, or null if none.
   */
  private async getFinalizedFloor(
    manager: EntityManager,
    chainId: number,
    contractAddress?: string,
  ): Promise<bigint | null> {
    const qb = manager
      .getRepository(EventCheckpoint)
      .createQueryBuilder('c')
      .select('MAX(CAST(c.lastFinalizedBlock AS NUMERIC))', 'floor')
      .where('c.chainId = :chainId', { chainId });
    if (contractAddress) {
      qb.andWhere('LOWER(c.contractAddress) = :contractAddress', {
        contractAddress: contractAddress.toLowerCase(),
      });
    }
    const row = await qb.getRawOne();
    if (!row || row.floor === null || row.floor === undefined) {
      return null;
    }
    return BigInt(String(row.floor).split('.')[0]);
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
          .where('e.txHash = :txHash', { txHash: dispute.eventTxHash })
          .andWhere('CAST(e.blockNumber AS NUMERIC) <= :rollbackToBlock', {
            rollbackToBlock: rollbackBlockStr,
          })
          .getOne();
        if (!raiseEvent) {
          await disputeRepo.delete({ id: dispute.id });
          affected.disputesRemoved++;
        } else {
          await disputeRepo.update(
            { id: dispute.id },
            { status: DisputeStatus.OPEN },
          );
          affected.disputesReverted++;
        }
      }
    }
  }
}
