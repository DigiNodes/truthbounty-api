import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FetchRequest, JsonRpcProvider } from 'ethers';
import { DisputeJournalStore } from './dispute-journal.store';
import { DisputeRelease, replayDisputes } from './finalized-dispute-projection';

/** Trusted operator configuration, never accepted from HTTP request data. */
@Injectable()
export class DisputeProjectionService {
  constructor(
    private readonly store: DisputeJournalStore,
    private readonly config: ConfigService,
  ) {}

  release(): DisputeRelease {
    const chainId = Number(this.config.get('CHAIN_ID'));
    const releaseId = this.config.get<string>('CONTRACT_RELEASE_ID') ?? '';
    const contractAddress = (
      this.config.get<string>('DISPUTE_PROJECTION_CONTRACT_ADDRESS') ?? ''
    ).toLowerCase();
    const deployment = String(
      this.config.get('CONTRACT_RELEASE_DEPLOYMENT_BLOCK') ?? '',
    );
    const decoderVersion =
      this.config.get<string>('DISPUTE_PROJECTION_DECODER_VERSION') ?? '';
    if (
      ![10, 11155420].includes(chainId) ||
      !releaseId.trim() ||
      !decoderVersion.trim() ||
      !/^0x[\da-f]{40}$/.test(contractAddress) ||
      !/^\d+$/.test(deployment)
    ) {
      throw new ServiceUnavailableException(
        'Dispute projection release binding is unavailable',
      );
    }
    return {
      chainId,
      releaseId,
      contractAddress,
      deploymentBlock: BigInt(deployment),
      decoderVersion,
    };
  }

  protected provider(): JsonRpcProvider {
    const url = this.config.get<string>('RPC_URL');
    if (!url || !/^https?:\/\//.test(url)) throw new Error('RPC unavailable');
    const request = new FetchRequest(url);
    request.timeout = 10000;
    // Disable cross-read caching: canonical hash checks must observe reorgs.
    return new JsonRpcProvider(request, undefined, { cacheTimeout: -1 });
  }

  async snapshot() {
    const release = this.release();
    let provider: JsonRpcProvider | undefined;
    try {
      provider = this.provider();
      if ((await provider.getNetwork()).chainId !== BigInt(release.chainId))
        throw new Error('Wrong RPC chain');
      const finalized = await provider.getBlock('finalized');
      if (!finalized?.hash || !Number.isSafeInteger(finalized.number))
        throw new Error('Finality unavailable');
      const height = BigInt(finalized.number);
      if (height < release.deploymentBlock)
        throw new Error('Release not finalized');
      const events = await this.store.events(release);
      const hashes = new Map<string, string>();
      for (const event of events) {
        if (!/^\d+$/.test(event.blockNumber))
          throw new Error('Malformed journal block');
        const block = BigInt(event.blockNumber);
        if (
          block < release.deploymentBlock ||
          block > height ||
          hashes.has(event.blockNumber)
        )
          continue;
        const canonical = await provider.getBlock(`0x${block.toString(16)}`);
        if (!canonical?.hash || BigInt(canonical.number) !== block)
          throw new Error('Canonical block unavailable');
        hashes.set(event.blockNumber, canonical.hash);
      }
      // A moving finalized tag is fine; a changed hash at the pinned height is not.
      const anchor = await provider.getBlock(finalized.number);
      if (anchor?.hash !== finalized.hash)
        throw new Error('Finalized anchor changed during replay');
      return {
        release: {
          ...release,
          deploymentBlock: release.deploymentBlock.toString(),
        },
        finalized: {
          blockNumber: height.toString(),
          blockHash: finalized.hash,
        },
        items: replayDisputes(events, release, height, hashes),
      };
    } catch {
      // Never expose provider URLs, database details, or partial terminal views.
      throw new ServiceUnavailableException(
        'Finalized dispute projection unavailable; retry after reconciliation',
      );
    } finally {
      provider?.destroy();
    }
  }
}
