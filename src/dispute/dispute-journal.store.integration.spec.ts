jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';
import { DisputeJournalStore } from './dispute-journal.store';
import { PrismaService } from '../prisma/prisma.service';

const databaseUrl = process.env.DISPUTE_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)(
  'dispute PostgreSQL persistence',
  () => {
    let pool: Pool;
    let client: PoolClient;
    let store: DisputeJournalStore;
    const schema = `dispute_test_${randomUUID().replace(/-/g, '')}`;
    const scope = {
      chainId: 10,
      releaseId: 'r',
      contractAddress: `0x${'a'.repeat(40)}`,
      deploymentBlock: 10n,
      decoderVersion: 'v1',
    };
    const migration = readFileSync(
      join(
        __dirname,
        '../../prisma/migrations/20261120140000_dispute_workflow/migration.sql',
      ),
      'utf8',
    );
    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl });
      client = await pool.connect();
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(migration);
      const prisma = {
        $queryRaw: async (
          strings: TemplateStringsArray,
          ...values: unknown[]
        ) => {
          const sql = strings.reduce(
            (result, part, index) => result + (index ? `$${index}` : '') + part,
            '',
          );
          return (await client.query(sql, values)).rows;
        },
      };
      store = new DisputeJournalStore(prisma as unknown as PrismaService);
    });
    afterAll(async () => {
      if (client) {
        await client.query(`DROP SCHEMA "${schema}" CASCADE`);
        client.release();
      }
      await pool?.end();
    });

    it('isolates workflows by chain/release/deployment and preserves JSON metadata', async () => {
      const row = await store.create(
        scope,
        "claim'quoted",
        scope.contractAddress,
        { outcome: 'untrusted' },
      );
      expect(row.initiatorAddress).toBe(scope.contractAddress);
      expect(row.metadata).toEqual({ outcome: 'untrusted' });
      expect(row).not.toHaveProperty('outcome');
      expect(await store.workflows({ ...scope, releaseId: 'other' })).toEqual(
        [],
      );
      expect(
        await store.review(
          { ...scope, chainId: 11155420 },
          row.id,
          scope.contractAddress,
          'DISMISSED',
          null,
        ),
      ).toBeNull();
      const reviewed = await store.review(
        scope,
        row.id,
        scope.contractAddress,
        'DISMISSED',
        'spam',
      );
      expect(reviewed?.reviewStatus).toBe('DISMISSED');
      expect(reviewed?.metadata).toEqual({ outcome: 'untrusted' });
      await expect(
        store.review(scope, row.id, scope.contractAddress, 'RESOLVED', null),
      ).rejects.toThrow();
    });

    it('rolls back and reapplies only the new workflow migration', async () => {
      await client.query(
        readFileSync(
          join(__dirname, '../../docs/runbooks/dispute-workflow-rollback.sql'),
          'utf8',
        ),
      );
      await client.query(migration);
      expect(await store.workflows(scope)).toEqual([]);
    });

    it('reads only the pinned, non-removed canonical journal source', async () => {
      await client.query(`CREATE TABLE "ChainEvent" (
      "chainId" INTEGER, "releaseId" TEXT, "contractAddress" TEXT, "decoderVersion" TEXT,
      "eventName" TEXT, "blockNumber" TEXT, "blockHash" TEXT, "txHash" TEXT,
      "logIndex" INTEGER, "payload" TEXT, "removed" BOOLEAN)`);
      for (const overrides of [
        {},
        { releaseId: 'other' },
        { chainId: 11155420 },
        { contractAddress: `0x${'b'.repeat(40)}` },
        { decoderVersion: 'other' },
        { removed: true },
      ]) {
        const row = { ...scope, removed: false, ...overrides };
        await client.query(
          `INSERT INTO "ChainEvent" VALUES ($1,$2,$3,$4,'DisputeRaised','10',$5,$6,0,'{}',$7)`,
          [
            row.chainId,
            row.releaseId,
            row.contractAddress,
            row.decoderVersion,
            `0x${'1'.repeat(64)}`,
            `0x${'2'.repeat(64)}`,
            row.removed,
          ],
        );
      }
      expect(await store.events(scope)).toHaveLength(1);
    });
  },
);
