// Stub for ESM-only multiformats package used in Jest tests.
// The real implementation is mocked at the module level in tests that use cid-verifier.
module.exports = {
  CID: {
    parse: jest.fn(),
  },
  sha256: {
    digest: jest.fn(),
  },
};
