import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import {
  validateException,
  validateInventory,
} from './dependency-inventory.mjs';

const require = createRequire(import.meta.url);
const inventory = JSON.parse(
  readFileSync(
    new URL('../docs/security/dependency-baseline.json', import.meta.url),
  ),
);
const lock = JSON.parse(
  readFileSync(new URL('../package-lock.json', import.meta.url)),
);

test('reviewed dependency paths, owners, and runtime classifications match the lockfile', () => {
  assert.deepEqual(validateInventory(inventory, lock), []);
  assert.deepEqual(inventory.approvedExceptions, []);
});

test('a development finding cannot silently become a production dependency', () => {
  const changed = structuredClone(lock);
  const finding = inventory.findings.find((row) => row.status === 'open');
  delete changed.packages[finding.resolutions[0].path].dev;
  assert.ok(
    validateInventory(inventory, changed).some((error) =>
      error.includes('production graph'),
    ),
  );
});

test('unreviewed resolutions and undocumented ownership fail validation', () => {
  const changed = structuredClone(inventory);
  changed.findings[0].resolutions[0].version = '0.0.0';
  changed.findings[0].owner = '';
  const errors = validateInventory(changed, lock);
  assert.ok(errors.some((error) => error.includes('resolution changed')));
  assert.ok(errors.some((error) => error.includes('missing ownership')));
});

const now = new Date('2026-10-16T00:00:00Z');
const example = {
  advisory: 'GHSA-example-test-only',
  owner: '@test-owner',
  approvedBy: '@test-reviewer',
  rationale: 'Synthetic test record; never an actual approval.',
  approvalUrl:
    'https://github.com/DigiNodes/truthbounty-api/issues/624#issuecomment-1',
  approvedAt: '2026-10-01T00:00:00Z',
  expiresAt: '2026-11-01T00:00:00Z',
  severity: 'moderate',
  reachability: 'dev-only',
};

test('exception metadata must include approval and a bounded, unexpired deadline', () => {
  assert.deepEqual(validateException(example, now), []);
  for (const change of [
    { expiresAt: '2026-10-16T00:00:00Z' },
    { expiresAt: '2027-01-01T00:00:00Z' },
    { approvedAt: '2026-12-01T00:00:00Z' },
    { approvedBy: '' },
    { approvalUrl: '' },
    { expiresAt: undefined },
    { severity: 'critical', reachability: 'reachable' },
  ])
    assert.ok(validateException({ ...example, ...change }, now).length > 0);
});

test('an approval record cannot suppress an unresolved high finding', () => {
  const changed = structuredClone(inventory);
  changed.findings[0].status = 'open';
  changed.findings[0].severity = 'high';
  changed.approvedExceptions = [example];
  assert.ok(
    validateInventory(changed, lock, now).some((error) =>
      error.includes('incomplete'),
    ),
  );
});

test('proxy trust rejects short mapped IPv6 prefixes without breaking valid proxy ranges', () => {
  const proxyaddr = require('proxy-addr');
  const unsafe = proxyaddr.compile(['::ffff:10.0.0.0/8']);
  assert.equal(unsafe('203.0.113.9'), false);
  const valid = proxyaddr.compile(['10.0.0.0/8']);
  assert.equal(valid('10.1.2.3'), true);
  assert.equal(valid('203.0.113.9'), false);
  assert.equal(
    proxyaddr(
      {
        socket: { remoteAddress: '203.0.113.9' },
        headers: {
          'x-forwarded-for': '10.1.2.3',
        },
      },
      unsafe,
    ),
    '203.0.113.9',
  );
});

test('URL-encoded parsing preserves nested values and enforces explicit array limits', () => {
  const qs = require('qs');
  assert.deepEqual(qs.parse('filter[state]=open&tags[]=one&tags[]=two'), {
    filter: { state: 'open' },
    tags: ['one', 'two'],
  });
  assert.throws(
    () =>
      qs.parse('tags[]=one&tags[]=two', {
        arrayLimit: 1,
        throwOnLimitExceeded: true,
      }),
    RangeError,
  );
  assert.equal(
    Object.hasOwn(qs.parse('__proto__[polluted]=true'), 'polluted'),
    false,
  );
});

test('URI normalization cannot inject a new authority through the port', () => {
  const uri = require('fast-uri');
  assert.equal(
    uri.parse('https://example.com:443/evidence').host,
    'example.com',
  );
  assert.throws(() =>
    uri.serialize({
      scheme: 'https',
      host: 'example.com',
      port: '443@other.example',
    }),
  );
});

test('Prisma configuration remains compatible with its patched merge dependency', () => {
  const { defineConfig } = require('@prisma/config');
  const config = defineConfig({
    schema: 'prisma/schema.prisma',
    migrations: { path: 'prisma/migrations' },
  });
  assert.equal(config.schema, 'prisma/schema.prisma');
  assert.equal(config.migrations.path, 'prisma/migrations');
  const { deepmerge } = require('deepmerge-ts');
  assert.deepEqual(deepmerge({ db: { timeout: 10 } }, { db: { retry: 2 } }), {
    db: { timeout: 10, retry: 2 },
  });
  const cyclic = {};
  cyclic.self = cyclic;
  const merged = deepmerge(cyclic, { enabled: true });
  assert.equal(merged.enabled, true);
  assert.equal(merged.self, merged);
});

test('the patched optional MySQL driver loads and preserves parameter escaping without a connection', () => {
  const mysql = require('mysql2');
  assert.equal(
    mysql.format('SELECT ? AS value', ["a'b"]),
    "SELECT 'a\\'b' AS value",
  );
});
