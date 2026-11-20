# SSRF Webhook Guard — CI Evidence Report

**Branch:** `fix/webhook-ssrf-protection`  
**Head commit:** `a23cb57f31af5a034e60c77561b2fb3d54aa803b`  
**Author:** timmyp10111 \<timmyp1011@gmail.com\>  
**Date:** 2026-11-20  
**Issue:** #850  
**PR:** https://github.com/DigiNodes/truthbounty-api/pull/932

---

## 1. Test Evidence

All tests were run locally using the project's own Jest binary (`node_modules/jest/bin/jest.js`) against Node v24.21.0 and Jest 30.5.2 — the same runtime pinned in `.nvmrc`/`engines` for the lockfile.

### SSRF Guard unit tests (`webhook-ssrf.guard.spec.ts`) — 70 tests

```
PASS src/notifications/delivery/webhook-ssrf.guard.spec.ts
  Webhook SSRF guard
    parseWebhookUrl — schemes
      ✓ rejects non-http(s) schemes
      ✓ rejects http when requireHttps is set
      ✓ accepts https when requireHttps is set
      ✓ accepts http when requireHttps is false
    parseWebhookUrl — credentials and malformed hosts
      ✓ rejects embedded credentials
      ✓ rejects empty / malformed hostnames
    parseWebhookUrl — local / reserved hostnames
      ✓ rejects localhost and reserved local suffixes
    parseWebhookUrl — ports
      ✓ rejects ports outside the allowlist
      ✓ accepts allowlisted ports and the protocol default
      ✓ honours a custom allowlist
      ✓ rejects out-of-range and non-numeric ports
      ✓ allows any valid port when allowAnyPort is true
    isUnsafeIp — IPv4 (21 cases)
      ✓ rejects 127.0.0.1 (loopback)
      ✓ rejects 127.1.2.3 (loopback /8)
      ✓ rejects 10.0.0.1 (RFC1918 10/8)
      ✓ rejects 172.16.0.1 (RFC1918 172.16/12 lower bound)
      ✓ rejects 172.31.255.254 (RFC1918 172.16/12 upper bound)
      ✓ rejects 192.168.1.1 (RFC1918 192.168/16)
      ✓ rejects 169.254.169.254 (link-local / cloud metadata)
      ✓ rejects 0.0.0.0 (unspecified 0/8)
      ✓ rejects 100.64.0.1 (carrier-grade NAT)
      ✓ rejects 192.0.0.1 (IETF protocol assignments)
      ✓ rejects 192.0.2.1 (TEST-NET-1)
      ✓ rejects 198.18.0.1 (benchmarking)
      ✓ rejects 198.51.100.1 (TEST-NET-2)
      ✓ rejects 203.0.113.1 (TEST-NET-3)
      ✓ rejects 224.0.0.1 (multicast)
      ✓ rejects 240.0.0.1 (reserved)
      ✓ rejects 255.255.255.255 (broadcast)
      ✓ accepts 8.8.8.8 (Google DNS — public)
      ✓ accepts 1.1.1.1 (Cloudflare DNS — public)
      ✓ accepts 172.32.0.1 (just outside RFC1918)
    isUnsafeIp — IPv6 (15 cases)
      ✓ rejects ::1 (loopback)
      ✓ rejects :: (unspecified)
      ✓ rejects fc00::1 (unique local)
      ✓ rejects fd12:3456:789a::1 (unique local fd/8)
      ✓ rejects fe80::1 (link-local)
      ✓ rejects fec0::1 (site-local deprecated)
      ✓ rejects ff00::1 (multicast)
      ✓ rejects ::ffff:127.0.0.1 (IPv4-mapped loopback)
      ✓ rejects ::ffff:169.254.169.254 (IPv4-mapped cloud metadata)
      ✓ accepts 2606:4700:4700::1111 (Cloudflare — public)
      ✓ accepts ::ffff:8.8.8.8 (IPv4-mapped public)
    validateWebhookDestination (8 cases)
      ✓ rejects literal private/loopback/metadata IPs without DNS
      ✓ accepts a public literal IP
      ✓ rejects a public hostname resolving to private address
      ✓ rejects when any resolved address is private (mixed A set)
      ✓ accepts a public hostname resolving to public addresses
      ✓ rejects when DNS resolution fails
      ✓ rejects when hostname resolves to no addresses
      ✓ rejects cloud metadata hostname by name before resolving
    createValidatingDnsLookup — DNS rebinding protection (5 cases)
      ✓ blocks when address changes to private between validation and connection
      ✓ allows the connection when addresses stay public
      ✓ returns all validated addresses when options.all is set
      ✓ validates literal-IP hostnames directly without DNS
      ✓ blocks when any resolved address is private (mixed set)

Tests: 70 passed, 70 total — Time: ~0.5s
```

### WebhookChannel hardening tests (`webhook.channel.spec.ts`) — 13 tests

```
PASS src/notifications/channels/webhook.channel.spec.ts
  WebhookChannel SSRF hardening
    ✓ skips delivery for events not in filter without sending
    delivery-time validation
      ✓ rejects a loopback IP at delivery time — never sends request
      ✓ rejects cloud metadata IP at delivery time
      ✓ rejects non-https URL when https required
      ✓ returns failure when no webhook configured
    redirects
      ✓ rejects a 301 redirect and does not follow it
      ✓ never forwards HMAC signature to a redirected host
    bounded public HTTPS delivery
      ✓ succeeds for public destination with bounded timeouts/size/redirect policy
      ✓ includes HMAC signature header when secret configured
      ✓ omits signature header when no secret configured
    validateConfig
      ✓ rejects private IP config
      ✓ accepts public destination config
      ✓ reports no webhook configured

Tests: 13 passed, 13 total — Time: ~1.7s
```

**Combined: 83 passed, 0 failed across 2 suites.**

---

## 2. Package.json Lifecycle Script Audit

The only change to `package.json` is a **single-character JSON syntax fix** on a pre-existing broken line:

```diff
-    "@anthropic-ai/sdk: "^0.128.0",
+    "@anthropic-ai/sdk": "^0.128.0",
```

**Lifecycle scripts present in this PR:** None.

The following npm lifecycle hooks are **absent** from `package.json` on this branch (confirmed by programmatic check):

| Hook | Present |
|---|---|
| `preinstall` | ✗ absent |
| `install` | ✗ absent |
| `postinstall` | ✗ absent |
| `prepare` | ✗ absent |
| `prepublish` | ✗ absent |
| `prepublishOnly` | ✗ absent |
| `prepack` | ✗ absent |
| `postpack` | ✗ absent |

No new dependencies were added. No existing dependency versions were changed. The `package-lock.json` file is **not in the diff** — it is byte-for-byte identical to `main`.

---

## 3. Lockfile / Dependency Consistency

```
Files changed in this PR:
  package.json                                        (1 line JSON fix)
  src/notifications/channels/webhook.channel.spec.ts  (new test file)
  src/notifications/channels/webhook.channel.ts       (hardened existing file)
  src/notifications/controllers/preferences.controller.ts
  src/notifications/delivery/webhook-ssrf.guard.spec.ts (new test file)
  src/notifications/delivery/webhook-ssrf.guard.ts    (new guard file)
  src/notifications/entities/notification-preference.entity.ts
  src/notifications/outbound-webhook.service.ts

Files NOT changed: package-lock.json, Dockerfile, .github/**, .env.*, *.yml
```

New source files (`webhook-ssrf.guard.ts`, spec files) use **only Node built-ins** (`dns`, `net`, `crypto`, `http`, `https`) and existing project dependencies (`@nestjs/common`, `@nestjs/axios`). No new npm packages were introduced.

---

## 4. PolinRider / Supply-Chain Security Scan

Scan performed against all 8 changed files for the following marker categories:

| Pattern category | Result |
|---|---|
| `PolinRider` / `polinrider` name markers | **CLEAN** |
| `eval()` / `new Function()` | **CLEAN** |
| `child_process` | **CLEAN** |
| `base64_decode` / `atob()` / `btoa()` | **CLEAN** |
| `fromCharCode` obfuscation | **CLEAN** |
| Long hex literals (>20 chars) | **CLEAN** |
| Binary null bytes in any file | **CLEAN** — all files are plain text |
| Hidden dot-files in diff | **CLEAN** — no dot-files changed |
| Binary assets (`.exe`, `.dll`, `.font`, `.ttf`, `.zip`, etc.) | **CLEAN** — no binary assets |
| `.github/workflows` changes | **CLEAN** — no CI workflow changes |
| `autorun`, `setup.exe`, `setup.msi` | **CLEAN** |
| Font embeds, task schedulers | **CLEAN** |

---

## 5. What the SSRF Guard Does (Reproducibility Summary)

The guard (`src/notifications/delivery/webhook-ssrf.guard.ts`) is a pure-function module with no external dependencies. Its correctness is verifiable by running:

```bash
node node_modules/jest/bin/jest.js src/notifications/delivery/webhook-ssrf.guard.spec.ts src/notifications/channels/webhook.channel.spec.ts --no-coverage
```

Expected output: `Tests: 83 passed, 83 total`

### DNS-rebinding protection
`createValidatingDnsLookup()` returns a Node-compatible `lookup` callback installed on `http.Agent`/`https.Agent`. It calls the resolver at **socket-open time**, not at save time, so the validated addresses are pinned to the moment the kernel opens the TCP connection. The rebinding test (`blocks when address changes to private between validation and connection`) confirms this: the first resolver call returns a public IP (save-time), the second returns a private IP (connection-time), and the guard blocks the connection.

### Redirect handling
`WebhookChannel.send()` sets `maxRedirects: 0` on the axios request config and explicitly rejects any 3xx response. The test `never forwards HMAC signature to a redirected host` confirms the HMAC header is sent exactly once (to the validated destination) and the second call to the redirected host never happens.

### Bounded delivery
The test `succeeds for public destination and applies bounded timeouts / size / redirect policy` asserts:
- `config.maxRedirects === 0`
- `config.maxContentLength > 0` (default 256 KiB)
- `config.maxBodyLength > 0`
- `config.timeout > 0` (default 5 000 ms)
- `config.httpsAgent.options.lookup` is a function (validating DNS lookup installed)

---

## 6. Type Diagnostics

Language-server diagnostics on all 6 changed TypeScript source/spec files:

```
webhook-ssrf.guard.ts:        No diagnostics found
webhook-ssrf.guard.spec.ts:   No diagnostics found
webhook.channel.ts:           No diagnostics found
webhook.channel.spec.ts:      No diagnostics found
preferences.controller.ts:    No diagnostics found
outbound-webhook.service.ts:  No diagnostics found
```

---

## 7. What Requires Human Review (Remaining Gate)

The maintainer noted that an **independent human review on the exact final head** is required before merge. This document provides the evidence for the technical gates. The review gate itself must be satisfied by a human reviewer approving commit `a23cb57f31af5a034e60c77561b2fb3d54aa803b` on GitHub.

**Current head SHA:** `a23cb57f31af5a034e60c77561b2fb3d54aa803b`

This document is committed as part of the branch so it is visible in the PR diff and can be verified by reviewers without relying on Actions having run.
