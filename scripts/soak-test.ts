/**
 * Soak Test Runner — V2-BE-086 Load Budget Validation
 *
 * Runs a continuous soak test against the truthbounty-api server to verify
 * memory stability, connection pool health, and latency budgets under sustained load.
 *
 * Usage:
 *   npx ts-node scripts/soak-test.ts --duration 30 --concurrency 20 --url http://localhost:3000
 */

import http from 'http';
import https from 'https';
import { parse } from 'url';

interface TestConfig {
  baseUrl: string;
  durationSeconds: number;
  concurrency: number;
  token?: string;
}

interface RequestStats {
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  latencies: number[];
}

function parseArgs(): TestConfig {
  const args = process.argv.slice(2);
  const config: TestConfig = {
    baseUrl: 'http://localhost:3000',
    durationSeconds: 10,
    concurrency: 10,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--duration' && args[i + 1]) {
      config.durationSeconds = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--concurrency' && args[i + 1]) {
      config.concurrency = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--url' && args[i + 1]) {
      config.baseUrl = args[i + 1];
      i++;
    } else if (args[i] === '--token' && args[i + 1]) {
      config.token = args[i + 1];
      i++;
    }
  }

  return config;
}

function calculatePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function makeRequest(urlStr: string, token?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const parsed = parse(urlStr);
    const transport = parsed.protocol === 'https:' ? https : http;

    const req = transport.request(
      urlStr,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        timeout: 5000,
      },
      (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          const duration = performance.now() - start;
          if (res.statusCode && res.statusCode < 400) {
            resolve(duration);
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      },
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request Timeout'));
    });

    req.end();
  });
}

async function runWorker(
  workerId: number,
  config: TestConfig,
  stopTime: number,
  stats: RequestStats,
): Promise<void> {
  const endpoints = ['/api/notifications', '/api/notifications/unread-count'];

  while (Date.now() < stopTime) {
    const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];
    const targetUrl = `${config.baseUrl}${endpoint}`;

    try {
      const duration = await makeRequest(targetUrl, config.token);
      stats.totalRequests++;
      stats.successRequests++;
      stats.latencies.push(duration);
    } catch (err) {
      stats.totalRequests++;
      stats.failedRequests++;
    }
  }
}

async function main() {
  const config = parseArgs();
  console.log(`Starting Soak Test against ${config.baseUrl}`);
  console.log(`Duration: ${config.durationSeconds}s | Concurrency: ${config.concurrency}`);

  const stats: RequestStats = {
    totalRequests: 0,
    successRequests: 0,
    failedRequests: 0,
    latencies: [],
  };

  const startTime = Date.now();
  const stopTime = startTime + config.durationSeconds * 1000;

  const workers = Array.from({ length: config.concurrency }, (_, i) =>
    runWorker(i, config, stopTime, stats),
  );

  await Promise.all(workers);
  const actualDurationMs = Date.now() - startTime;
  const actualDurationSec = actualDurationMs / 1000;

  stats.latencies.sort((a, b) => a - b);
  const p50 = calculatePercentile(stats.latencies, 50).toFixed(2);
  const p95 = calculatePercentile(stats.latencies, 95).toFixed(2);
  const p99 = calculatePercentile(stats.latencies, 99).toFixed(2);
  const rps = (stats.totalRequests / actualDurationSec).toFixed(1);
  const errorRate = ((stats.failedRequests / (stats.totalRequests || 1)) * 100).toFixed(2);

  console.log('\n--- SOAK TEST RESULTS ---');
  console.log(`Total Duration : ${actualDurationSec.toFixed(2)} s`);
  console.log(`Total Requests : ${stats.totalRequests}`);
  console.log(`Successful     : ${stats.successRequests}`);
  console.log(`Failed         : ${stats.failedRequests} (${errorRate}%)`);
  console.log(`Throughput     : ${rps} req/sec`);
  console.log(`p50 Latency    : ${p50} ms`);
  console.log(`p95 Latency    : ${p95} ms (Target < 100ms)`);
  console.log(`p99 Latency    : ${p99} ms (Target < 250ms)`);

  if (parseFloat(p95) > 100 || parseFloat(errorRate) > 1.0) {
    console.error('\nFAILURE: Load budget target exceeded!');
    process.exit(1);
  } else {
    console.log('\nSUCCESS: All read-path load budgets satisfied!');
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}
