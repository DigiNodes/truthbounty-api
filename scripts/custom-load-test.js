const http = require('http');

const runTest = async () => {
    let successCount = 0;
    let errorCount = 0;
    let latencies = [];
    const target = 500; // total requests
    const concurrency = 50;

    console.log(`Starting load test: ${target} requests, ${concurrency} concurrency`);
    const startTime = Date.now();

    const executeRequest = () => {
        return new Promise((resolve) => {
            const reqStart = Date.now();
            const req = http.request({
                hostname: 'localhost',
                port: 3000,
                path: '/api/v2/claim-read-models?limit=20',
                method: 'GET'
            }, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    const duration = Date.now() - reqStart;
                    latencies.push(duration);
                    if (res.statusCode === 200) {
                        successCount++;
                    } else {
                        errorCount++;
                    }
                    resolve();
                });
            });

            req.on('error', (e) => {
                errorCount++;
                resolve();
            });
            req.end();
        });
    };

    let activeRequests = 0;
    let completedRequests = 0;

    await new Promise(resolve => {
        const interval = setInterval(() => {
            while (activeRequests < concurrency && activeRequests + completedRequests < target) {
                activeRequests++;
                executeRequest().then(() => {
                    activeRequests--;
                    completedRequests++;
                });
            }
            if (completedRequests >= target) {
                clearInterval(interval);
                resolve();
            }
        }, 10);
    });

    const totalTime = Date.now() - startTime;
    latencies.sort((a, b) => a - b);
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length || 0;
    const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;

    console.log(`\n--- Test Results ---`);
    console.log(`Total Requests: ${target}`);
    console.log(`Successes: ${successCount}`);
    console.log(`Errors:    ${errorCount}`);
    console.log(`Total Time: ${totalTime} ms`);
    console.log(`Throughput: ${(target / (totalTime / 1000)).toFixed(2)} req/sec`);
    console.log(`Avg Latency: ${avgLatency.toFixed(2)} ms`);
    console.log(`P95 Latency: ${p95} ms`);

    if (avgLatency > 500) {
        console.log(`\nBottleneck identified: High latency (${avgLatency.toFixed(2)} ms > 500 ms). Possible causes: Database locking, sync operations, lack of connection pooling.`);
    } else {
        console.log(`\nPerformance is adequate. No immediate bottlenecks found at this concurrency.`);
    }
};

runTest();
