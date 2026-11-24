import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { BlockCursorService } from './block-cursor.service';
import { setupPrismaTestDatabase } from '../../../test/utils/prisma-test-db.helper';

describe('BlockCursorService (integration)', () => {
  let service: BlockCursorService;
  let prisma: PrismaService;
  let cleanup: () => void;

  beforeAll(async () => {
    ({ cleanup } = setupPrismaTestDatabase('block-cursor'));

    const module: TestingModule = await Test.createTestingModule({
      providers: [BlockCursorService, PrismaService],
    }).compile();

    service = module.get(BlockCursorService);
    prisma = module.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    cleanup();
  });

  const CHAIN = 10;
  const SOURCE = '0xAbC0000000000000000000000000000000dEf0';

  it('creates a cursor on first recordBlock and advances it on subsequent calls', async () => {
    await service.recordBlock(CHAIN, SOURCE, {
      height: 100n,
      hash: '0xblock100',
      parentHash: '0xblock99',
    });

    let cursor = await service.getCursor(CHAIN, SOURCE);
    expect(cursor?.processedHeight).toBe(100n);
    expect(cursor?.processedHash).toBe('0xblock100');

    await service.recordBlock(CHAIN, SOURCE, {
      height: 101n,
      hash: '0xblock101',
      parentHash: '0xblock100',
    });

    cursor = await service.getCursor(CHAIN, SOURCE);
    expect(cursor?.processedHeight).toBe(101n);
    expect(cursor?.processedHash).toBe('0xblock101');
  });

  it('updateConfirmations advances safe/finalized cursors', async () => {
    await service.updateConfirmations(
      CHAIN,
      SOURCE,
      { height: 100n, hash: '0xblock100', parentHash: '0xblock99' },
      { height: 99n, hash: '0xblock99', parentHash: '0xblock98' },
    );

    const cursor = await service.getCursor(CHAIN, SOURCE);
    expect(cursor?.safeHeight).toBe(100n);
    expect(cursor?.finalizedHeight).toBe(99n);
  });

  it('findCommonAncestor finds the last matching height/hash and lists orphaned heights above it', async () => {
    const source = `${SOURCE}-reorg`;
    await service.recordBlock(CHAIN, source, {
      height: 10n,
      hash: '0xh10',
      parentHash: '0xh9',
    });
    await service.recordBlock(CHAIN, source, {
      height: 11n,
      hash: '0xh11-orphan',
      parentHash: '0xh10',
    });
    await service.recordBlock(CHAIN, source, {
      height: 12n,
      hash: '0xh12-orphan',
      parentHash: '0xh11-orphan',
    });

    // RPC's current canonical view: height 10 unchanged, 11/12 reorged out.
    const result = await service.findCommonAncestor(CHAIN, source, [
      { height: 10n, hash: '0xh10', parentHash: '0xh9' },
      { height: 11n, hash: '0xh11-canonical', parentHash: '0xh10' },
      { height: 12n, hash: '0xh12-canonical', parentHash: '0xh11-canonical' },
    ]);

    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.ancestor.height).toBe(10n);
      expect(result.ancestor.hash).toBe('0xh10');
      expect(result.orphanedHeights.sort()).toEqual([11n, 12n]);
    }
  });

  it('recoverToAncestor rewinds the cursor and marks orphaned ancestry non-canonical', async () => {
    const source = `${SOURCE}-recover`;
    await service.recordBlock(CHAIN, source, {
      height: 10n,
      hash: '0xh10',
      parentHash: '0xh9',
    });
    await service.recordBlock(CHAIN, source, {
      height: 11n,
      hash: '0xh11-orphan',
      parentHash: '0xh10',
    });

    await service.recoverToAncestor(CHAIN, source, {
      height: 10n,
      hash: '0xh10',
      parentHash: '0xh9',
    });

    const cursor = await service.getCursor(CHAIN, source);
    expect(cursor?.processedHeight).toBe(10n);
    expect(cursor?.processedHash).toBe('0xh10');

    // The reorg-safe replacement for height 11 can now be recorded without
    // colliding with the orphaned entry.
    await service.recordBlock(CHAIN, source, {
      height: 11n,
      hash: '0xh11-canonical',
      parentHash: '0xh10',
    });

    const advanced = await service.getCursor(CHAIN, source);
    expect(advanced?.processedHeight).toBe(11n);
    expect(advanced?.processedHash).toBe('0xh11-canonical');
  });
});
