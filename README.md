# 🔍 TruthBounty API

**Decentralized News Verification Infrastructure**  
*An open-source public good for incentivizing truth across Ethereum and Stellar ecosystems*


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

## 🌱 Ecosystem Alignment (Ethereum, Stellar & Public Goods)

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

## 🌟 Stellar Ecosystem Alignment (Planned & Compatible)

TruthBounty is designed as a **chain-agnostic verification protocol**, with first-class compatibility for ecosystems that prioritize **low-cost transactions, public goods, and global accessibility** — making **Stellar a natural extension target**.

### Why Stellar?

- **Ultra-low fees** enable high-frequency verification without economic friction  
- **Global accessibility** aligns with TruthBounty’s mission to fight misinformation worldwide  
- **Soroban smart contracts** are well-suited for:
  - Reward distribution
  - Reputation state updates
  - Verifier staking logic  
- **Stellar’s public-good focus** mirrors TruthBounty’s commitment to open infrastructure

### Planned Stellar Integrations

- Optional reward settlement on Stellar for micro-incentives  
- Cross-chain verification proofs (Ethereum ↔ Stellar)  
- Soroban-based reputation and reward modules  
- Support for Stellar-native wallets for verifier onboarding  

TruthBounty treats **blockchains as infrastructure, not lock-in**, enabling communities to verify truth wherever participation is most accessible.

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

### Multi-Chain Support

| Network | Role |
|-------|-----|
| Ethereum / Optimism | Primary reward settlement |
| Stellar (planned) | Low-cost verification & micro-rewards |

---

## 🛠️ Setup Guide

### Prerequisites

- Node.js v18+
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
npm run start:dev

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
