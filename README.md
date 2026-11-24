# 🔍 TruthBounty API

**Decentralized News Verification Infrastructure**  
*An open-source public good for incentivizing truth on Ethereum and Optimism*


![License](https://img.shields.io/badge/license-MIT-green)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)
![Status](https://img.shields.io/badge/status-active%20development-blue)

---

## 🌍 Why TruthBounty?

Misinformation erodes trust, fuels conflict, and weakens democratic and social systems.  
TruthBounty exists to turn **fact-checking into a decentralized public good**, powered by cryptoeconomic incentives rather than centralized authority.

This API provides the core infrastructure for:

- Community-driven news verification  
- Reputation-based trust scoring  
- Transparent, verifiable evidence storage  
- On-chain rewards for honest participation  

By aligning incentives with truth, TruthBounty enables communities to collectively defend information integrity.

---

## 🌱 Ecosystem Alignment (Ethereum, Optimism & Public Goods)

TruthBounty is intentionally built within the **Ethereum ecosystem** and aligned with open-source public-good values:

- **Ethereum** – neutral, permissionless base layer  
- **Optimism** – scalable, low-cost reward distribution  
- **IPFS** – decentralized evidence storage  
- **Worldcoin ID** – Sybil resistance for fair participation  
- **Drips Network** – sustainable funding for maintainers and contributors  

This API is designed to be **forkable, composable, and reusable** by:

- News platforms  
- Civic-tech organizations  
- Browser extensions  
- DAO governance systems  
- Research and media tooling  

---

## 🔗 Runtime Authority

TruthBounty's runtime authority is **Optimism/EVM**. Deployed Optimism contracts and finalized canonical events are the source of protocol truth. This API indexes, projects and serves them.

- **Chain:** Optimism Mainnet (chain ID 10) and Optimism Sepolia (chain ID 11155420)
- **Persistence:** PostgreSQL via TypeORM. SQLite is a local development and test fallback only.
- **Deployment and release manifest:** [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- **Protocol and authorization boundaries:** [docs/API_AUTHORIZATION_MATRIX.md](docs/API_AUTHORIZATION_MATRIX.md)
- **Contract artifact routing:** [docs/V2_ARTIFACT_ROUTING.md](docs/V2_ARTIFACT_ROUTING.md)
- **Legacy persistence inventory:** [docs/PRISMA_INVENTORY.md](docs/PRISMA_INVENTORY.md)

Stellar appears in this repository only as the Drips Wave funding program that coordinates contributions. It is not a runtime, wallet, settlement or deployment target.

---

## 🧩 High-Level Architecture

1. News reports are submitted via the API  
2. Verifiers authenticate using Worldcoin ID  
3. Users stake tokens to participate in verification  
4. Evidence (links, screenshots, metadata) is stored on IPFS  
5. Reputation scores are recalculated in real time  
6. Smart contracts distribute rewards on Optimism  
7. Verification results are exposed via public API endpoints  

> The API is intentionally modular to support multiple frontends and clients.

---

## 🚀 Core Features

- 🛡️ Reputation-weighted verification using staked tokens  
- 💰 ERC-20 reward distribution on Optimism  
- 🔗 IPFS evidence storage with cryptographic proofs  
- 🌐 Sybil-resistant authentication via Worldcoin ID  
- 📊 Real-time reputation scoring engine  
- 🤖 AI-assisted fake-news detection (optional / pluggable)  
- 📋 Comprehensive audit trail for all critical actions
- 🔍 Complete traceability for claims, evidence, and rewards  

---

## ✨ What Makes TruthBounty Different?

| Aspect | Traditional Fact-Checking | TruthBounty |
|------|---------------------------|-------------|
| Control | Centralized | Community-driven |
| Incentives | None / Salaried | Tokenized rewards |
| Transparency | Opaque | On-chain + IPFS |
| Identity | Anonymous | Sybil-resistant |
| Trust Model | Editorial authority | Cryptoeconomic |

TruthBounty treats **truth as infrastructure**, not opinion.

---

## ⚙️ Tech Stack

### Backend Core

| Technology | Purpose |
|---------|--------|
| NestJS | API framework |
| PostgreSQL | Primary database |
| TypeORM | ORM |
| Redis | Caching & sessions |

### Web3 & Decentralized Infrastructure

| Technology | Purpose |
|----------|--------|
| Ethereum / Optimism | Reward distribution |
| Ethers.js | Blockchain interaction |
| IPFS | Evidence storage |
| Worldcoin ID | Sybil resistance |

### DevOps & Tooling

| Technology | Purpose |
|----------|--------|
| Docker | Containerization |
| GitHub Actions | CI/CD |

### Runtime Chain

| Network | Role |
|-------|-----|
| Optimism (chain ID 10; Sepolia 11155420) | Only runtime and settlement chain |
| Optimism (chain ID 10, Sepolia 11155420) | Only runtime and settlement chain |

---

## 🛠️ Setup Guide

### Prerequisites

- Node.js 20 LTS and npm 10 (see docs/DEPLOYMENT.md)
- PostgreSQL 14+
- Redis 6+
- Git
- Worldcoin Developer Account (for ID verification)

---

### Installation

```bash
# Clone repository
git clone https://github.com/DigiNodes/truthbounty-api.git
cd truthbounty-api

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your credentials including:
# - Database configuration
# - Worldcoin App ID and Action ID

# Start in development mode
npx nest start --watch

# Access API documentation at http://localhost:3000/api
```

---

## 🌐 API Endpoints

### Worldcoin Identity Verification

**POST** `/identity/worldcoin/verify` - Verify user with Worldcoin ID  
**GET** `/identity/worldcoin/status/:userId` - Check verification status  
**GET** `/identity/worldcoin/verification/:nullifierHash` - Lookup by nullifier hash

### Blockchain Integration

**GET** `/blockchain/events` - Get indexed blockchain events  
**POST** `/blockchain/reconcile` - Trigger state reconciliation  

---

## 🧪 Testing

```bash
# Run all tests
npm test

# Run Worldcoin-specific tests
npm test -- --testPathPattern=worldcoin

# Run with coverage
npm run test:cov
```

---

## 👥 Contributing

We welcome contributors of all levels.

### Ways to Contribute

- Backend features & optimizations
- Security reviews & audits
- Documentation & diagrams
- API integrations
- Test coverage

### Contribution Workflow

- Fork the repository
- Create a feature branch
- Follow Conventional Commits
- Submit a PR with a clear description
- Participate in code review

See CONTRIBUTING.md for full guidelines.

---

## 🔒 Security

We take security seriously. If you discover any security vulnerabilities, please refer to our **[Security Policy](SECURITY.md)** for instructions on how to report them. Please **do not** report security issues through public GitHub issues.

---

## 📄 License

This project is licensed under the MIT License.
