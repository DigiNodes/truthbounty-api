# Local Reproduction & API CI Quality Gates (V2-BE-044)

This guide documents how to reproduce and verify API security, testing, and build gates locally.

---

## 🛠️ Required API Quality & Security Gates

### 1. Type Checking
```bash
npm run type-check
```

### 2. Linting
```bash
npm run lint
```

### 3. Unit & Integration Tests with Coverage
```bash
npm run test:cov
```

### 4. Build & Generated Artifact Drift Check
```bash
npm run build
git status --porcelain
```

### 5. Dependency Audit
```bash
npm audit --audit-level=high
```

### 6. Container Build & Vulnerability Scan
```bash
docker build -t truthbounty-api:test .
```

---

## 🔒 Security & Least Privilege

* **Non-Skippable Gates:** Skips and permissive continuations have been removed from required checks.
* **Sensitive Changes Protection:** Pull requests modifying authentication, database migrations, indexer code, or CI workflows require explicit maintainer review.
* **Pinned Tooling:** Actions and security scanners are pinned to secure releases.
