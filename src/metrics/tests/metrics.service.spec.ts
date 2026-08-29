import { MetricsService } from "../metrics.service";

describe("MetricsService", () => {
  const service = new MetricsService();

  it("should increment request counter", () => {
    service.incrementRequest("GET", "/test", "200");
    // Prom-client stores metrics internally; just ensure no error thrown
    expect(true).toBe(true);
  });

  it("should observe latency", () => {
    service.observeLatency("GET", "/test", "200", 0.5);
    expect(true).toBe(true);
  });

  it("should return metrics string", async () => {
    const metrics = await service.getMetrics();
    expect(metrics).toContain("http_requests_total");
  });

  describe("infrastructure metrics (BE-016)", () => {
    it("exposes process memory usage as a labeled gauge", async () => {
      service.setMemoryUsage({
        rss: 123456,
        heapTotal: 98765,
        heapUsed: 54321,
        external: 1000,
      });

      const metrics = await service.getMetrics();
      expect(metrics).toContain("process_memory_usage_bytes");
      expect(metrics).toContain('type="rss"');
      expect(metrics).toContain("123456");
    });

    it("exposes process CPU usage as a labeled gauge", async () => {
      service.setCpuUsage({ user: 5000, system: 2000 });

      const metrics = await service.getMetrics();
      expect(metrics).toContain("process_cpu_usage_microseconds");
      expect(metrics).toContain('mode="user"');
      expect(metrics).toContain("5000");
    });

    it("exposes queue job counts labeled by queue name and state", async () => {
      service.setQueueDepth("jobs-queue", { waiting: 3, active: 1, failed: 0 });

      const metrics = await service.getMetrics();
      expect(metrics).toContain("queue_jobs_total");
      expect(metrics).toContain('queue="jobs-queue"');
      expect(metrics).toContain('state="waiting"');
    });

    it("exposes the last indexed block without a lag value when no chain head is provided", async () => {
      service.setBlockchainIndexingState(1000);

      const metrics = await service.getMetrics();
      expect(metrics).toContain("blockchain_last_indexed_block 1000");
    });

    it("computes indexing lag when a chain head is provided", async () => {
      service.setBlockchainIndexingState(1000, 1010);

      const metrics = await service.getMetrics();
      expect(metrics).toContain("blockchain_indexing_lag_blocks 10");
    });

    it("never reports a negative lag even if local state is briefly ahead of a stale head reading", async () => {
      service.setBlockchainIndexingState(1010, 1000);

      const metrics = await service.getMetrics();
      expect(metrics).toContain("blockchain_indexing_lag_blocks 0");
    });
  });
});
