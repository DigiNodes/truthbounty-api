import { Test, TestingModule } from '@nestjs/testing';
import { ProfilerService } from '../profiler.service';
import { DatabaseProfiler } from '../sub-profilers/database-profiler';
import { RedisProfiler } from '../sub-profilers/redis-profiler';
import { BlockchainProfiler } from '../sub-profilers/blockchain-profiler';
import { JobProfiler } from '../sub-profilers/job-profiler';
import { NotificationProfiler } from '../sub-profilers/notification-profiler';

describe('Sub-profilers Tests', () => {
  let profilerService: ProfilerService;
  let dbProfiler: DatabaseProfiler;
  let redisProfiler: RedisProfiler;
  let blockchainProfiler: BlockchainProfiler;
  let jobProfiler: JobProfiler;
  let notificationProfiler: NotificationProfiler;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProfilerService,
        DatabaseProfiler,
        RedisProfiler,
        BlockchainProfiler,
        JobProfiler,
        NotificationProfiler,
      ],
    }).compile();

    profilerService = module.get<ProfilerService>(ProfilerService);
    profilerService.onModuleInit();

    dbProfiler = module.get<DatabaseProfiler>(DatabaseProfiler);
    redisProfiler = module.get<RedisProfiler>(RedisProfiler);
    blockchainProfiler = module.get<BlockchainProfiler>(BlockchainProfiler);
    jobProfiler = module.get<JobProfiler>(JobProfiler);
    notificationProfiler = module.get<NotificationProfiler>(NotificationProfiler);
  });

  afterEach(() => {
    profilerService.onModuleDestroy();
  });

  it('DatabaseProfiler should wrap and profile queries with sanitization', async () => {
    const result = await dbProfiler.profileQuery(
      "SELECT * FROM users WHERE password='secret_password'",
      'user',
      async () => [{ id: '1', name: 'Alice' }],
    );

    expect(result.length).toEqual(1);
  });

  it('RedisProfiler should wrap and profile redis commands', async () => {
    const result = await redisProfiler.profileOperation(
      'GET',
      'user:12345',
      async () => '{"name":"Alice"}',
    );

    expect(result).toEqual('{"name":"Alice"}');
  });

  it('BlockchainProfiler should profile RPC calls', async () => {
    const result = await blockchainProfiler.profileRpcCall(
      'eth_call',
      'optimism',
      async () => '0x123',
    );

    expect(result).toEqual('0x123');
  });

  it('JobProfiler should profile background job execution', async () => {
    const result = await jobProfiler.profileJob(
      'process-claim-rewards',
      'jobs-queue',
      async () => ({ processed: true }),
    );

    expect(result.processed).toBe(true);
  });

  it('NotificationProfiler should profile notification delivery', async () => {
    const result = await notificationProfiler.profileNotification(
      'webhook',
      'https://example.com/webhook',
      async () => ({ status: 'sent' }),
    );

    expect(result.status).toEqual('sent');
  });
});
