import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CanonicalEvent } from './entities/canonical-event.entity';
import { CanonicalEventScope } from './canonical-event-scope';

export interface CanonicalEventScope {
  chainId: number;
  deploymentBlock: string;
  releaseId: string;
  artifactChecksum: string;
}

/**
 * Read-only access to canonical events for downstream V2 projectors
 * (evidence, verification, disputes). Ordering is always
 * (blockNumber, logIndex) ascending -- the deterministic protocol order --
 * never insertion order or id.
 */
@Injectable()
export class CanonicalEventQueryService {
  constructor(
    @InjectRepository(CanonicalEvent)
    private readonly events: Repository<CanonicalEvent>,
    private readonly config: ConfigService,
  ) {}

  getScope(): CanonicalEventScope {
    const chainIdValue = this.config.get<number | string>('CHAIN_ID');
    const deploymentBlockValue = this.config.get<number | string>(
      'CONTRACT_RELEASE_DEPLOYMENT_BLOCK',
    );
    const releaseId = this.config.get<string>('CONTRACT_RELEASE_ID');
    const artifactChecksum = this.config.get<string>(
      'CONTRACT_RELEASE_SHA256',
    );
    const chainId = Number(chainIdValue);
    const deploymentBlock = String(deploymentBlockValue ?? '');

    if (
      ![10, 11155420].includes(chainId) ||
      !/^\d+$/.test(deploymentBlock) ||
      !releaseId ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(releaseId) ||
      !artifactChecksum ||
      !/^[a-f0-9]{64}$/.test(artifactChecksum)
    ) {
      throw new Error('Canonical event projector scope is not configured');
    }

    const indexerReleaseId = this.config.get<string>('INDEXER_RELEASE_ID');
    const indexerDeploymentBlock = this.config.get<number | string>(
      'INDEXER_DEPLOYMENT_BLOCK',
    );
    if (
      (indexerReleaseId !== undefined && indexerReleaseId !== releaseId) ||
      (indexerDeploymentBlock !== undefined &&
        String(indexerDeploymentBlock) !== deploymentBlock)
    ) {
      throw new Error('Canonical event projector scope does not match indexer');
    }

    return {
      chainId,
      deploymentBlock,
      releaseId,
      artifactChecksum,
    };
  }

  getScopedProjectorName(projectorName: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(projectorName)) {
      throw new Error('Invalid projector name');
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(this.getScope()))
      .digest('hex')
      .slice(0, 24);
    return `${projectorName}-${fingerprint}`;
  }

  getScopedProjectorNames(projectorNames: readonly string[]): string[] {
    return projectorNames.map((name) => this.getScopedProjectorName(name));
  }

  assertEventInScope(
    chainId: number,
    blockNumber: string | number | bigint,
    artifactVersion?: string,
  ): void {
    const scope = this.getScope();
    let normalizedBlock: bigint;
    try {
      normalizedBlock = BigInt(blockNumber);
    } catch {
      throw new Error('Canonical event is outside configured release scope');
    }
    if (
      chainId !== scope.chainId ||
      normalizedBlock < BigInt(scope.deploymentBlock) ||
      (artifactVersion !== undefined && artifactVersion !== scope.releaseId)
    ) {
      throw new Error('Canonical event is outside configured release scope');
    }
  }

  private normalizeBlockNumber(value: unknown): string | null {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!/^\d+$/.test(trimmed)) return null;
      return trimmed;
    }
    if (typeof value === 'number') {
      if (!Number.isInteger(value) || value < 0) return null;
      return String(value);
    }
    if (typeof value === 'bigint') {
      if (value < 0n) return null;
      return value.toString();
    }
    return null;
  }

  /**
   * Fetch events by name, strictly after the given (blockNumber, logIndex)
   * order key, in ascending protocol order. Pass `null` to start from genesis.
   */
  async findAfter(
    eventNames: string[],
    scope: CanonicalEventScope,
    after: { blockNumber: string | number | bigint; logIndex: number } | null,
    limit: number,
  ): Promise<CanonicalEvent[]> {
    if (
      !scope ||
      (scope.chainId !== 10 && scope.chainId !== 11155420)
    ) {
      throw new Error('A supported canonical event chain scope is required');
    }
    if (!Array.isArray(eventNames) || eventNames.length === 0) return [];
    if (!Number.isInteger(limit) || limit <= 0) return [];

    const scope = this.getScope();
    const normalizedBlockNumber =
      after !== null && after !== undefined
        ? this.normalizeBlockNumber(after.blockNumber)
        : null;
    if (
      after !== null &&
      after !== undefined &&
      (normalizedBlockNumber === null ||
        !Number.isInteger(after.logIndex) ||
        after.logIndex < -1)
    ) {
      throw new Error('Invalid canonical projector cursor');
    }
    const hasCursor = after !== null && after !== undefined;

    const qb = this.events
      .createQueryBuilder('e')
      .where('e.chainId = :chainId', { chainId: scope.chainId })
      .andWhere('e.blockNumber >= :deploymentBlock', {
        deploymentBlock: scope.deploymentBlock,
      })
      .andWhere('e.artifactVersion = :releaseId', {
        releaseId: scope.releaseId,
      })
      .andWhere('e.eventName IN (:...eventNames)', { eventNames })
      .orderBy('e.blockNumber', 'ASC')
      .addOrderBy('e.logIndex', 'ASC')
      .limit(limit);

    if (hasCursor) {
      qb.andWhere(
        '(e.blockNumber > :blockNumber OR (e.blockNumber = :blockNumber AND e.logIndex > :logIndex))',
        {
          blockNumber: normalizedBlockNumber,
          logIndex: after.logIndex,
        },
      );
    }

    return qb.getMany();
  }
}
