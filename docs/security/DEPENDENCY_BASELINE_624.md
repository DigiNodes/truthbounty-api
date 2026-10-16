# Dependency baseline remediation (#624)

This change is stacked on PR #608 at
`b58707b4537309a51412d87a56ed0fc9f8419f03`. It does not close parent #584 or
claim its source, container, or full CI baseline is repaired. The contributor is
`toyosi-14`; the security owner remains `@dDevAhmed` under `.github/CODEOWNERS`.

## Measured scope

The 2026-10-16 audit reports affected **packages**, including packages that inherit
the same advisory. These counts are not distinct CVEs.

| Lockfile audit                       | Critical | High | Moderate |
| ------------------------------------ | -------: | ---: | -------: |
| Before                               |        3 |    7 |       22 |
| After                                |        0 |    0 |       20 |
| Production-only after (`--omit=dev`) |        0 |    0 |        0 |

[dependency-baseline.json](dependency-baseline.json) maps all 32 original affected
packages to advisory IDs, direct/transitive relationships, parent ranges, original
versions, reviewed resolutions, reachability evidence, status, and owner. Advisory
IDs link to `https://github.com/advisories/<ID>`. Lockfile classification is not
proof of absence from a built image; container validation remains a separate gate.

## Upgrades

The lockfile was regenerated with Node 22.23.3 and npm 10.9.9 using targeted
`npm update --package-lock-only --ignore-scripts` for the affected packages.
No `--force`, `--legacy-peer-deps`, dependency override, audit exclusion, or
threshold reduction was used. Direct dependency ranges are unchanged.

| Dependency              | Before                 | After                   | Compatibility boundary                                                          |
| ----------------------- | ---------------------- | ----------------------- | ------------------------------------------------------------------------------- |
| proxy-addr              | 2.0.7                  | 2.0.8                   | Express's existing 2.x range                                                    |
| qs                      | 6.15.3                 | 6.16.1                  | Existing Express/body-parser ranges                                             |
| fast-uri                | 3.1.4                  | 3.1.8                   | AJV's existing 3.x range; no 4.x migration                                      |
| prisma / @prisma/config | 7.10.0                 | 7.10.1                  | Prisma's patch release selects its own new transitive dependencies              |
| deepmerge-ts            | 7.1.5                  | 8.0.2                   | Required and pinned by @prisma/config 7.10.1, not an override of Prisma's range |
| mysql2                  | 3.15.3                 | 3.24.4                  | Selected by Prisma 7.10.1; satisfies TypeORM's optional peer                    |
| handlebars              | 4.7.9                  | 4.7.10                  | Existing ts-jest range                                                          |
| piscina                 | 4.9.3                  | 4.9.4                   | Existing SWC CLI 4.x range                                                      |
| brace-expansion         | 1.1.12 / 2.1.3 / 5.0.9 | 1.1.21 / 2.1.7 / 5.0.12 | Each consumer stays on its existing major                                       |
| @humanfs/node           | 0.16.7                 | 0.16.8                  | Existing ESLint range                                                           |
| http-cache-semantics    | 4.2.0                  | 4.3.0                   | Existing cacheable-request range                                                |

The other changed resolutions are dependencies of these fixes, including Prisma's
engines and MySQL's escaping implementation. Review the lockfile, not a floating
registry tag, for the exact shipped versions and integrity hashes.

The tracked Prisma client is regenerated with 7.10.1 so its generator and engine
metadata agree with the patched tooling. Two generation runs produced identical
files. No Prisma schema or migration is changed.

## Reachability and residual findings

- `proxy-addr` is on the Express trust-proxy path configured from `TRUSTED_PROXIES`
  in `src/bootstrap.ts`. Wallet throttling reads the resulting request IP. This is
  a runtime security boundary, so the patched subnet behavior is tested directly.
- `qs` processes URL-encoded requests because bootstrap enables `extended: true`.
  The regression checks nested parsing, array limits, and prototype-key handling.
- Prisma configuration, `deepmerge-ts`, `fast-uri`, and `mysql2` occur in the
  production lockfile through dependency/peer relationships. The configured
  application uses PostgreSQL/SQLite and libsql, not MySQL. We do not use that fact
  to waive findings: the affected resolutions are patched. Tests exercise URI
  validation, Prisma configuration/merge compatibility, and driver loading and
  escaping without making database or network connections.
- The remaining 20 moderate package reports inherit
  [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) through
  Jest/ts-jest's `@istanbuljs/load-nyc-config -> js-yaml -> argparse -> sprintf-js`
  path. They are **open**, not risk-accepted. The published `sprintf-js` releases
  remain affected as of the review date; npm's suggested Jest/ts-jest major
  downgrades are not a supported remediation. These lockfile nodes are dev-only,
  and the production-only audit is clean. Re-review when a fix is published; do
  not interpret this statement as a claim that build-time dependencies are safe.

No exception has been approved or introduced. The `approvedExceptions` list is
empty. Metadata validation rejects missing approval evidence, future approvals,
expired or longer-than-90-day exceptions, and reachable critical exceptions.
It also rejects **every** unresolved high/critical finding, even if an exception
record is present. It cannot grant or authenticate maintainer approval, and never
changes the independent `npm audit --audit-level=high` result.

## Reproduction and validation

```sh
npm ci
npm run security:dependencies:test
node scripts/dependency-inventory.mjs
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
npm run type-check
npm run build
npm test -- --runInBand
```

The security CI job runs the offline regression/inventory tests before the
unchanged audit gate. The validator fails if reviewed resolutions drift or a
dependency classified as development-only enters the production graph. The test
suite includes synthetic invalid exception records; none represent an approval.

Clean-install, deterministic-lockfile, application build/test, and container
results are recorded in the PR with their actual scope and outstanding baseline
failures. A clean audit is not evidence that the application builds or that the
container scan passed. #608/#584 and the exact-head human review remain merge
prerequisites.
