import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  generateDecoderAllowlist,
  CanonicalDecoderAllowlist,
  RawReleaseManifest,
} from '../../../src/v2/events/decoder-allowlist';

const manifestPath = resolve(
  __dirname,
  '../../../contracts/manifests/optimism-sepolia.release.json',
);
const rawManifest = JSON.parse(
  readFileSync(manifestPath, 'utf-8'),
) as RawReleaseManifest;

const allowlistResult = generateDecoderAllowlist(rawManifest);
if (!allowlistResult.valid || !allowlistResult.allowlist) {
  throw new Error('Failed to generate deterministic Optimism Sepolia decoder fixtures');
}

export const OPTIMISM_SEPOLIA_DECODER_FIXTURES: {
  manifest: RawReleaseManifest;
  allowlist: CanonicalDecoderAllowlist;
  sampleLogs: {
    validClaimSubmitted: {
      chainId: number;
      address: string;
      topics: string[];
      data: string;
      transactionHash: string;
      logIndex: number;
      blockNumber: bigint;
    };
    unknownTopicLog: {
      chainId: number;
      address: string;
      topics: string[];
      data: string;
      transactionHash: string;
      logIndex: number;
      blockNumber: bigint;
    };
    unregisteredAddressLog: {
      chainId: number;
      address: string;
      topics: string[];
      data: string;
      transactionHash: string;
      logIndex: number;
      blockNumber: bigint;
    };
    legacyAddressLog: {
      chainId: number;
      address: string;
      topics: string[];
      data: string;
      transactionHash: string;
      logIndex: number;
      blockNumber: bigint;
    };
    malformedDataLog: {
      chainId: number;
      address: string;
      topics: string[];
      data: string;
      transactionHash: string;
      logIndex: number;
      blockNumber: bigint;
    };
    changedIndexedFieldLog: {
      chainId: number;
      address: string;
      topics: string[];
      data: string;
      transactionHash: string;
      logIndex: number;
      blockNumber: bigint;
    };
  };
} = {
  manifest: rawManifest,
  allowlist: allowlistResult.allowlist,
  sampleLogs: {
    validClaimSubmitted: {
      chainId: 11155420,
      address: '0x0000000000000000000000000000000000001001',
      topics: [
        '0x1ade945054b1cb7694489e6babea1f79bd9d8896dd5cfde28dd775a01a39b3f9',
        '0x' + '11'.repeat(32), // claimId
        '0x000000000000000000000000' + '22'.repeat(20), // author
      ],
      data: '0x0000000000000000000000000000000000000000000000000000000000000020' +
        '0x0000000000000000000000000000000000000000000000000000000000000007' +
        '697066733a2f2f00000000000000000000000000000000000000000000000000',
      transactionHash: '0x' + 'aa'.repeat(32),
      logIndex: 0,
      blockNumber: 24850010n,
    },
    unknownTopicLog: {
      chainId: 11155420,
      address: '0x0000000000000000000000000000000000001001',
      topics: ['0x' + 'ee'.repeat(32)],
      data: '0x',
      transactionHash: '0x' + 'bb'.repeat(32),
      logIndex: 1,
      blockNumber: 24850011n,
    },
    unregisteredAddressLog: {
      chainId: 11155420,
      address: '0x0000000000000000000000000000000000009999',
      topics: ['0x1ade945054b1cb7694489e6babea1f79bd9d8896dd5cfde28dd775a01a39b3f9'],
      data: '0x',
      transactionHash: '0x' + 'cc'.repeat(32),
      logIndex: 2,
      blockNumber: 24850012n,
    },
    legacyAddressLog: {
      chainId: 11155420,
      address: '0x1111111111111111111111111111111111111111', // legacy address from previous wave
      topics: ['0x1ade945054b1cb7694489e6babea1f79bd9d8896dd5cfde28dd775a01a39b3f9'],
      data: '0x',
      transactionHash: '0x' + 'dd'.repeat(32),
      logIndex: 3,
      blockNumber: 24850013n,
    },
    malformedDataLog: {
      chainId: 11155420,
      address: '0x0000000000000000000000000000000000001001',
      topics: [
        '0x1ade945054b1cb7694489e6babea1f79bd9d8896dd5cfde28dd775a01a39b3f9',
        '0x' + '11'.repeat(32),
        '0x000000000000000000000000' + '22'.repeat(20),
      ],
      data: '0x1234', // truncated malformed data
      transactionHash: '0x' + 'ee'.repeat(32),
      logIndex: 4,
      blockNumber: 24850014n,
    },
    changedIndexedFieldLog: {
      chainId: 11155420,
      address: '0x0000000000000000000000000000000000001001',
      // only 1 topic when 3 (topic0 + 2 indexed) are expected
      topics: ['0x1ade945054b1cb7694489e6babea1f79bd9d8896dd5cfde28dd775a01a39b3f9'],
      data: '0x12345678',
      transactionHash: '0x' + 'ff'.repeat(32),
      logIndex: 5,
      blockNumber: 24850015n,
    },
  },
};
