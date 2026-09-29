# V2 Artifact Routing

V2 event ingestion resolves an approved artifact only for Optimism Mainnet
(`chainId` 10) or Optimism Sepolia (`chainId` 11155420). The lookup key is the
lowercase `(chainId, contractAddress)` pair; there is no default ABI fallback.

Each `v2_contract_artifacts` row must contain:

- a lowercase, 20-byte EVM address;
- a non-empty release `artifactVersion`;
- the exact ABI used for decoding; and
- `abiChecksum`, the lowercase SHA-256 hex digest of `JSON.stringify(abi)`.

Rows with an unsupported chain, malformed or non-canonical address, missing
version, checksum drift, or an unparsable ABI are treated as unavailable. The
ingestion service then quarantines the raw log as `UNREGISTERED_ADDRESS`; it
does not decode with a legacy or fabricated ABI.

## Migration and recovery

Apply the V2 canonical-event migration before approving artifacts. When an ABI
is replaced, register the new version and checksum as a reviewed deployment
artifact, approve it, clear the in-process artifact cache, and replay affected
logs only after the canonical chain and finality checkpoints have been
verified. Do not update an existing approved row in place while ingestion is
running.

To calculate a checksum in Node.js:

```js
const crypto = require('node:crypto');
const checksum = crypto.createHash('sha256').update(JSON.stringify(abi)).digest('hex');
```