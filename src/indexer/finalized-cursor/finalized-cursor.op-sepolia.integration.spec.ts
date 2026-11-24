import { ethers } from 'ethers';
import { register } from 'prom-client';
import { FinalizedCursorService } from './finalized-cursor.service';
import { ReleaseBinding } from './finalized-cursor.types';
import {
  InMemoryFinalizedCursorStore,
  InMemoryProjectionHandle,
} from './testing/in-memory-finalized-cursor.store';

/**
 * Optimism Sepolia finalized-watermark integration test (PREWAVE-BE-001).
 *
 * Runs only when OP_SEPOLIA_RPC_URL is set, e.g.
 *   OP_SEPOLIA_RPC_URL=https://sepolia.optimism.io npx jest finalized-cursor.op-sepolia
 * The RPC URL is never logged or asserted on.
 */
const RPC_URL = process.env.OP_SEPOLIA_RPC_URL;
const OP_SEPOLIA_CHAIN_ID = 11155420;
const describeIfRpc = RPC_URL ? describe : describe.skip;

describeIfRpc('FinalizedCursorService against Optimism Sepolia', () => {
  jest.setTimeout(60_000);
  afterAll(() => register.resetMetrics());

  it('advances the indexed watermark to the provider finalized head and no further', async () => {
    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, {
      staticNetwork: true,
    });
    const network = await provider.getNetwork();
    expect(Number(network.chainId)).toBe(OP_SEPOLIA_CHAIN_ID);

    const finalizedBlock = await provider.getBlock('finalized');
    expect(finalizedBlock).not.toBeNull();
    const deploymentBlock = BigInt(finalizedBlock!.number) - 20n;

    const binding: ReleaseBinding = {
      chainId: OP_SEPOLIA_CHAIN_ID,
      releaseId: 'integration-op-sepolia',
      deploymentBlock,
      artifactChecksum: '0'.repeat(64),
    };
    const store = new InMemoryFinalizedCursorStore();
    const policy = { maxIndexLagBlocks: 1_000_000, maxHeadAgeMs: 60_000 };
    const service = new FinalizedCursorService<InMemoryProjectionHandle>(
      store,
      {
        binding,
        policy,
      },
    );

    await service.initialize(binding);
    await expect(
      service.observeHeadsFromProvider(binding, provider),
    ).resolves.toEqual({
      accepted: true,
    });

    const heads = await service.getStatus(binding);
    expect(heads.finalizedHead!).toBeGreaterThanOrEqual(finalizedBlock!.number);
    expect(heads.safeHead!).toBeGreaterThanOrEqual(heads.finalizedHead!);
    expect(heads.observedHead!).toBeGreaterThanOrEqual(heads.safeHead!);

    const target = BigInt(heads.finalizedHead!);
    const targetBlock = await provider.getBlock(Number(target));
    await expect(
      service.applyFinalizedRange(
        binding,
        {
          fromBlock: deploymentBlock,
          toBlock: target,
          toBlockHash: targetBlock!.hash!,
          events: [],
        },
        async () => undefined,
      ),
    ).resolves.toMatchObject({ status: 'applied', indexedWatermark: target });

    // Indexing past the finalized head must fail closed.
    await expect(
      service.applyFinalizedRange(
        binding,
        {
          fromBlock: target + 1n,
          toBlock: BigInt(heads.observedHead!) + 1n,
          toBlockHash: targetBlock!.hash!,
          events: [],
        },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FINALIZED' });

    // A restarted instance resumes at the same watermark.
    const restarted = new FinalizedCursorService<InMemoryProjectionHandle>(
      store,
      {
        binding,
        policy,
      },
    );
    const status = await restarted.getStatus(binding);
    expect(status.indexedWatermark).toBe(Number(target));
    expect(status.ready).toBe(true);
    provider.destroy();
  });
});
