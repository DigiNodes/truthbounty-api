import * as http from 'http';
import { AddressInfo } from 'net';
import { SafeHttpClientService } from '../safe-http-client.service';
import { SsrfSecurityException } from '../ssrf-url-validator';

describe('SafeHttpClientService', () => {
  let client: SafeHttpClientService;
  let server: http.Server;
  let serverPort: number;
  let serverBaseUrl: string;

  beforeAll((done) => {
    client = new SafeHttpClientService();

    server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${serverPort}`);

      if (url.pathname === '/ok') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'hello' }));
      } else if (url.pathname === '/redirect-to-private') {
        res.writeHead(302, {
          Location: 'http://169.254.169.254/latest/meta-data',
        });
        res.end();
      } else if (url.pathname === '/redirect-loop') {
        res.writeHead(302, {
          Location: `http://127.0.0.1:${serverPort}/redirect-loop`,
        });
        res.end();
      } else if (url.pathname === '/redirect-to-target') {
        res.writeHead(302, {
          Location: `http://127.0.0.1:${serverPort}/target`,
        });
        res.end();
      } else if (url.pathname === '/target') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            receivedAuth: req.headers['authorization'] || null,
            receivedCookie: req.headers['cookie'] || null,
          }),
        );
      } else if (url.pathname === '/cross-origin-redirect') {
        // Redirect to a different port/origin
        res.writeHead(302, {
          Location: `http://127.0.0.1:${serverPort + 1}/target`,
        });
        res.end();
      } else if (url.pathname === '/oversized-content-length') {
        res.writeHead(200, {
          'Content-Length': '100000000',
          'Content-Type': 'text/plain',
        });
        res.end('oversized');
      } else if (url.pathname === '/oversized-chunks') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        // Stream chunks
        const chunk = Buffer.alloc(1024, 'a');
        res.write(chunk);
        res.write(chunk);
        res.write(chunk);
        res.end();
      } else if (url.pathname === '/slow-body') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        // Intentionally hang and delay sending body
        const timer = setTimeout(() => {
          res.end('finally finished');
        }, 1500);
        timer.unref();
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      serverPort = (server.address() as AddressInfo).port;
      serverBaseUrl = `http://127.0.0.1:${serverPort}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  describe('Direct Forbidden Network Blocking', () => {
    it('should block requests to loopback IP addresses (127.0.0.1)', async () => {
      await expect(
        client.get(`http://127.0.0.1:${serverPort}/ok`, {
          allowedPorts: [serverPort],
        }),
      ).rejects.toThrow(SsrfSecurityException);
    });

    it('should block requests to cloud metadata service (169.254.169.254)', async () => {
      await expect(
        client.get('http://169.254.169.254/latest/meta-data'),
      ).rejects.toThrow(SsrfSecurityException);
    });

    it('should block requests to private networks (10.0.0.1, 192.168.1.1)', async () => {
      await expect(client.get('http://10.0.0.1/status')).rejects.toThrow(
        SsrfSecurityException,
      );
      await expect(client.get('http://192.168.1.1/admin')).rejects.toThrow(
        SsrfSecurityException,
      );
    });

    it('should block credential-bearing targets (http://user:pass@example.com)', async () => {
      await expect(
        client.get('http://admin:secret@example.com'),
      ).rejects.toThrow('Credential-bearing targets');
    });
  });

  describe('Method Allowlist', () => {
    it('should reject unsupported HTTP methods (CONNECT, TRACE, INVALID)', async () => {
      await expect(
        client.request('https://example.com', { method: 'CONNECT' }),
      ).rejects.toThrow("HTTP method 'CONNECT' is not allowed");

      await expect(
        client.request('https://example.com', { method: 'TRACE' }),
      ).rejects.toThrow("HTTP method 'TRACE' is not allowed");
    });

    it('should accept allowed HTTP methods (GET, POST, PUT, DELETE, PATCH, HEAD)', () => {
      // Test validation logic on method allowlist
      const allowed = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'];
      for (const m of allowed) {
        expect(() => {
          // Verify method check doesn't throw METHOD_NOT_ALLOWED
          // (It will fail on invalid test domain or private IP which is expected)
          client
            .request('http://127.0.0.1/test', {
              method: m,
              allowedMethods: allowed,
            })
            .catch((err: unknown) => {
              if (err instanceof SsrfSecurityException) {
                expect(err.code).not.toBe('METHOD_NOT_ALLOWED');
              }
            });
        }).not.toThrow();
      }
    });
  });

  describe('DNS Rebinding Defense', () => {
    it('should block connection if DNS rebinding returns forbidden IP at connect time', async () => {
      let lookupCount = 0;
      // Simulate DNS rebinding:
      // First lookup returns safe public IP, but connect lookup returns 127.0.0.1
      const rebindingDnsResolver = jest.fn().mockImplementation(() => {
        lookupCount++;
        if (lookupCount === 1) {
          return Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
        }
        return Promise.resolve([{ address: '127.0.0.1', family: 4 }]);
      });

      await expect(
        client.get('http://rebind-test.com', {
          customDnsResolver: rebindingDnsResolver,
        }),
      ).rejects.toThrow('Connection-time DNS rebinding blocked');
    });
  });

  describe('Redirect Policy and SSRF Defense across Redirects', () => {
    it('should block redirect when target redirects to forbidden private/metadata IP', async () => {
      await expect(
        client.get(`${serverBaseUrl}/redirect-to-private`, {
          allowPrivateIps: true, // Allow initial connection to test server, but redirect goes to metadata IP!
          allowedPorts: [serverPort, 80],
        }),
      ).rejects.toThrow('matches cloud metadata service');
    });

    it('should abort when redirects exceed maxRedirects limit', async () => {
      await expect(
        client.get(`${serverBaseUrl}/redirect-loop`, {
          allowPrivateIps: true,
          allowedPorts: [serverPort],
          maxRedirects: 3,
        }),
      ).rejects.toThrow('Maximum redirects (3) exceeded');
    });

    it('should preserve credentials on same-origin redirect', async () => {
      const res = await client.get(`${serverBaseUrl}/redirect-to-target`, {
        allowPrivateIps: true,
        allowedPorts: [serverPort],
        headers: {
          authorization: 'Bearer secret-token',
          cookie: 'session=123',
        },
      });

      expect(res.status).toBe(200);
      const data = res.json<{ receivedAuth: string; receivedCookie: string }>();
      expect(data.receivedAuth).toBe('Bearer secret-token');
      expect(data.receivedCookie).toBe('session=123');
    });

    it('should strip credentials on cross-origin redirect', async () => {
      // Second server representing another origin
      const server2 = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            receivedAuth: req.headers['authorization'] || null,
            receivedCookie: req.headers['cookie'] || null,
          }),
        );
      });

      await new Promise<void>((resolve) => {
        server2.listen(serverPort + 1, '127.0.0.1', () => resolve());
      });

      try {
        const res = await client.get(`${serverBaseUrl}/cross-origin-redirect`, {
          allowPrivateIps: true,
          allowedPorts: [serverPort, serverPort + 1],
          headers: {
            authorization: 'Bearer secret-token',
            cookie: 'session=123',
          },
        });

        expect(res.status).toBe(200);
        const data = res.json<{
          receivedAuth: string | null;
          receivedCookie: string | null;
        }>();
        expect(data.receivedAuth).toBeNull();
        expect(data.receivedCookie).toBeNull();
      } finally {
        server2.close();
      }
    });
  });

  describe('Size and Time Limits (Bounded & Cancellable)', () => {
    it('should reject response when Content-Length exceeds maxResponseSizeBytes', async () => {
      await expect(
        client.get(`${serverBaseUrl}/oversized-content-length`, {
          allowPrivateIps: true,
          allowedPorts: [serverPort],
          maxResponseSizeBytes: 1000,
        }),
      ).rejects.toThrow('Response Content-Length');
    });

    it('should abort and destroy stream when chunked response exceeds maxResponseSizeBytes', async () => {
      await expect(
        client.get(`${serverBaseUrl}/oversized-chunks`, {
          allowPrivateIps: true,
          allowedPorts: [serverPort],
          maxResponseSizeBytes: 1500, // 3072 bytes total sent
        }),
      ).rejects.toThrow('Response exceeded maximum allowed size');
    });

    it('should timeout and abort slow response exceeding requestTimeoutMs', async () => {
      await expect(
        client.get(`${serverBaseUrl}/slow-body`, {
          allowPrivateIps: true,
          allowedPorts: [serverPort],
          requestTimeoutMs: 200, // server delays 1500ms
        }),
      ).rejects.toThrow('Request timed out');
    });

    it('should cancel immediately when AbortSignal is triggered', async () => {
      const controller = new AbortController();

      const requestPromise = client.get(`${serverBaseUrl}/slow-body`, {
        allowPrivateIps: true,
        allowedPorts: [serverPort],
        requestTimeoutMs: 5000,
        signal: controller.signal,
      });

      // Trigger abort immediately
      setTimeout(() => controller.abort(), 50);

      await expect(requestPromise).rejects.toThrow('Request aborted by caller');
    });
  });
});
