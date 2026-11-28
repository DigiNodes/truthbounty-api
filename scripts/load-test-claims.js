import http from 'k6/http';
import { check, sleep } from 'k6';

// Test configuration
export const options = {
    scenarios: {
        stress_test: {
            executor: 'ramping-arrival-rate',
            startRate: 10,
            timeUnit: '1s',
            preAllocatedVUs: 50,
            maxVUs: 200,
            stages: [
                { duration: '30s', target: 50 },  // Ramp up to 50 requests per second
                { duration: '1m', target: 150 },  // Ramp up to 150 requests per second (stress)
                { duration: '30s', target: 150 }, // Sustain peak load
                { duration: '30s', target: 0 },   // Ramp down
            ],
        },
    },
    thresholds: {
        http_req_duration: ['p(95)<500'], // 95% of requests should be below 500ms
        http_req_failed: ['rate<0.01'],   // Error rate should be less than 1%
    },
};

const BASE_URL = __ENV.API_URL || 'http://localhost:3000';

export default function () {
    const url = `${BASE_URL}/api/v2/claim-read-models?limit=20`;
    const res = http.get(url);

    check(res, {
        'is status 200': (r) => r.status === 200,
        'transaction time OK': (r) => r.timings.duration < 500,
    });

    sleep(1);
}
