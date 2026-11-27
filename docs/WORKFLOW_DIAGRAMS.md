# Backend Workflow Diagrams

This document contains visual representations of the key backend workflows in the TruthBounty API system.

## Claim Flow

```mermaid
graph TD
    A[User/Client] --> B[POST /claims]
    B --> C[ClaimsController.createClaim]
    C --> D[ClaimsService.createClaim]
    D --> E[Save claim metadata only]
    E --> F[Return metadata and canonical read-model link]
    F --> G[Canonical event ingestion]
    G --> H[Approved artifact decode and quarantine]
    H --> I[Finality checkpoint and projection]
    I --> J[GET /api/v2/claim-read-models]
    J --> K{Matching finalized VerdictSettled event?}
    K -->|Yes| L[Serve finalized projection with provenance]
    K -->|No| M[Fail closed or retain provisional state]

    F --> N[POST /claims/:claimId/evidence]
    N --> O[EvidenceService.createEvidence]
    O --> P[Save evidence record and version]
    
    style A fill:#e1f5fe
    style F fill:#c8e6c9
    style L fill:#c8e6c9
    style M fill:#fff3cd
```

### Claim Flow Steps

1. **Claim Creation**
   - Client submits claim metadata via `POST /claims`
   - The API stores metadata and returns a link to the release-bound read model
   - Claim creation does not assign a verdict or finality

2. **Canonical Projection**
   - Approved contract artifacts decode canonical Optimism/EVM events
   - Unknown, malformed, or unapproved events are quarantined
   - Finality is determined by the checkpoint for the emitting contract
   - The read API serves a finalized claim only when its matching
     `VerdictSettled` event and approved release provenance are verified
   - Missing or unfinalized events never produce a finalized claim

3. **Evidence Submission**
   - Client adds evidence via `POST /claims/:claimId/evidence`
   - Evidence record created with version 1
   - Evidence version stored with CID reference
   - Audit trail records evidence submission

## Verification Flow

```mermaid
graph TD
    A[User/Client] --> B[POST /identity/worldcoin/verify]
    B --> C[WorldcoinController.verifyWorldcoin]
    C --> D[WorldcoinService.verifyProof]
    D --> E[Validate Worldcoin Proof]
    E --> F{Proof Valid?}
    F -->|No| G[Throw BadRequestException]
    F -->|Yes| H[Check Nullifier Hash]
    H --> I{Nullifier Used?}
    I -->|Yes| J[Throw ConflictException]
    I -->|No| K[Create Verification Record]
    K --> L[Save to Database]
    L --> M[Return Verification Response]
    
    M --> N[GET /identity/worldcoin/status/:userId]
    N --> O[WorldcoinController.getVerificationStatus]
    O --> P[WorldcoinService.getVerificationStatus]
    P --> Q[Return Verification Status]
    
    Q --> R[POST /identity/users/:id/verify-worldcoin]
    R --> S[IdentityController.verifyWorldcoin]
    S --> T[SybilResistanceService.setWorldcoinVerified]
    T --> U[Update Sybil Score]
    U --> V[Return Updated Status]
    
    V --> W[GET /identity/users/:id/sybil-score]
    W --> X[IdentityController.getSybilScore]
    X --> Y[SybilResistanceService.getLatestSybilScore]
    Y --> Z[Return Sybil Score]
    
    style A fill:#e1f5fe
    style M fill:#c8e6c9
    style Q fill:#c8e6c9
    style V fill:#c8e6c9
    style Z fill:#4caf50
    style G fill:#ffcdd2
    style J fill:#ffcdd2
```

### Verification Flow Steps

1. **Worldcoin Verification**
   - Client submits Worldcoin proof via `POST /identity/worldcoin/verify`
   - System validates proof with Worldcoin infrastructure
   - Checks for duplicate nullifier hash usage
   - Creates verification record if valid
   - Returns verification response

2. **Verification Status Check**
   - Client checks verification status via `GET /identity/worldcoin/status/:userId`
   - System retrieves latest verification for user
   - Returns verification status and details

3. **Sybil Score Update**
   - System updates user's Sybil resistance score via `POST /identity/users/:id/verify-worldcoin`
   - SybilResistanceService recalculates score based on verification
   - Returns updated status

4. **Sybil Score Retrieval**
   - Client retrieves current Sybil score via `GET /identity/users/:id/sybil-score`
   - System returns latest Sybil score for user

## Data Flow Architecture

```mermaid
graph LR
    subgraph "Client Layer"
        A[Frontend Client]
        B[Mobile App]
    end
    
    subgraph "API Gateway"
        C[NestJS Controllers]
    end
    
    subgraph "Business Logic"
        D[Claims Service]
        E[Evidence Service]
        F[Worldcoin Service]
        G[Identity Service]
        H[Sybil Resistance Service]
    end
    
    subgraph "Data Layer"
        I[PostgreSQL Database]
        J[Redis Cache]
        K[Audit Trail]
    end
    
    subgraph "External Services"
        L[Worldcoin API]
        M[IPFS Storage]
    end
    
    A --> C
    B --> C
    C --> D
    C --> E
    C --> F
    C --> G
    C --> H
    
    D --> I
    D --> J
    D --> K
    E --> I
    E --> J
    E --> K
    E --> M
    F --> I
    F --> K
    F --> L
    G --> I
    G --> K
    H --> I
    H --> K
    
    style A fill:#e3f2fd
    style B fill:#e3f2fd
    style I fill:#f3e5f5
    style J fill:#f3e5f5
    style K fill:#f3e5f5
    style L fill:#fff3e0
    style M fill:#fff3e0
```

## Cache Strategy

```mermaid
graph TD
    A[Request] --> B{Cache Check}
    B -->|Hit| C[Return Cached Data]
    B -->|Miss| D[Query Database]
    D --> E[Process Business Logic]
    E --> F[Update Cache]
    F --> G[Return Response]
    
    H[Claim Created/Updated] --> I[Invalidate Claim Cache]
    J[Evidence Updated] --> K[Invalidate Evidence Cache]
    L[User Verification] --> M[Invalidate User Cache]
    
    I --> N[Update Cache with Fresh Data]
    K --> N
    M --> N
    
    style C fill:#c8e6c9
    style F fill:#fff3cd
    style N fill:#c8e6c9
```

## Audit Trail Integration

```mermaid
graph TD
    A[User Action] --> B[Controller Method]
    B --> C[Service Method]
    C --> D[@AuditLog Decorator]
    D --> E[AuditTrailService.log]
    E --> F[Create Audit Entry]
    F --> G[Save to Audit Table]
    G --> H[Return to Service]
    H --> I[Complete Business Logic]
    I --> J[Return Response]
    
    subgraph "Audit Data Captured"
        K[Action Type]
        L[Entity Type]
        M[Entity ID]
        N[User ID]
        O[Description]
        P[Before State]
        Q[After State]
        R[Timestamp]
    end
    
    E --> K
    E --> L
    E --> M
    E --> N
    E --> O
    E --> P
    E --> Q
    E --> R
    
    style G fill:#e8f5e8
    style J fill:#e8f5e8
```

## Error Handling Flow

```mermaid
graph TD
    A[Request] --> B[Validation]
    B --> C{Valid?}
    C -->|No| D[HTTP Exception]
    C -->|Yes| E[Business Logic]
    E --> F{Success?}
    F -->|No| G[Service Exception]
    F -->|Yes| H[Cache Update]
    H --> I[Audit Log]
    I --> J[Success Response]
    
    D --> K[Error Response]
    G --> L[Error Logging]
    L --> K
    
    subgraph "Exception Types"
        M[BadRequestException]
        N[NotFoundException]
        O[ConflictException]
        P[UnauthorizedException]
    end
    
    D --> M
    D --> N
    D --> O
    D --> P
    
    style K fill:#ffcdd2
    style J fill:#c8e6c9
```

These diagrams provide a comprehensive overview of the backend workflows, data flow, and system architecture for the TruthBounty API. They can be used for:

- Developer onboarding and understanding
- System documentation
- Architecture discussions
- Troubleshooting and debugging
- Feature planning and development
