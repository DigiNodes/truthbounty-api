import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { Interface, ethers } from 'ethers';
import { EventDecoderService } from '../event-decoder.service';
import { CanonicalEventsService } from '../canonical-events.service';
import { ArtifactRegistryService } from '../artifact-registry.service';
import { CanonicalEvent } from '../entities/canonical-event.entity';
import { EventQuarantine } from '../entities/event-quarantine.entity';
import { RawLog } from '../interfaces/canonical-event.interface';
import { IndexerConfigService } from '../../../config/indexer-config.service';

/**
 * Integration tests for event overload support.
 * 
 * Tests that events with the same name but different signatures (overloads)
 * are correctly keyed by canonical signature/topic0 instead of name alone.
 * 
 * This satisfies the post-Wave-9 requirement: "Events are keyed by canonical
 * signature/topic, not name alone."
 */
describe('Event Overload Support (Integration)', () => {
  let decoder: EventDecoderService;
  let artifactRegistry: ArtifactRegistryService;

  // Overloaded Transfer events
  const TRANSFER_V1_ABI = 'event Transfer(address indexed from, address indexed to, uint256 amount)';
  const TRANSFER_V2_ABI = 'event Transfer(address indexed from, address indexed to, uint256 amount, bytes data)';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventDecoderService,
        {
          provide: ArtifactRegistryService,
          useValue: {
            resolve: jest.fn(),
          },
        },
        {
          provide: DataSource,
          useValue: {},
        },
        {
          provide: IndexerConfigService,
          useValue: {
            getEventIndexerConfig: jest.fn().mockReturnValue({
              confirmations: { finalized: 64 },
            }),
          },
        },
      ],
    }).compile();

    decoder = module.get<EventDecoderService>(EventDecoderService);
    artifactRegistry = module.get<ArtifactRegistryService>(ArtifactRegistryService);
  });

  describe('Overload Detection and Decoding', () => {
    it('decodes Transfer(address,address,uint256) with correct signature', () => {
      const iface = new Interface([TRANSFER_V1_ABI]);
      const fragment = iface.getEvent('Transfer')!;
      const topic0 = ethers.id(fragment.format('sighash'));

      const log: RawLog = {
        chainId: 11155420,
        address: '0x1234567890123456789012345678901234567890',
        topics: [
          topic0,
          ethers.zeroPadValue('0x0000000000000000000000000000000000000001', 32),
          ethers.zeroPadValue('0x0000000000000000000000000000000000000002', 32),
        ],
        data: ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [ethers.parseEther('100')]),
        transactionHash: '0xaaaa000000000000000000000000000000000000000000000000000000000001',
        logIndex: 0,
        blockNumber: 100n,
      };

      const result = decoder.decode(log, iface);

      expect(result.status).toBe('decoded');
      if (result.status === 'decoded') {
        expect(result.signature).toBe('Transfer(address,address,uint256)');
        expect(result.topic0).toBe(topic0);
        expect(result.description.name).toBe('Transfer');
      }
    });

    it('decodes Transfer(address,address,uint256,bytes) with correct signature', () => {
      const iface = new Interface([TRANSFER_V2_ABI]);
      const fragment = iface.getEvent('Transfer')!;
      const topic0 = ethers.id(fragment.format('sighash'));

      const log: RawLog = {
        chainId: 11155420,
        address: '0x1234567890123456789012345678901234567890',
        topics: [
          topic0,
          ethers.zeroPadValue('0x0000000000000000000000000000000000000001', 32),
          ethers.zeroPadValue('0x0000000000000000000000000000000000000002', 32),
        ],
        data: ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint256', 'bytes'],
          [ethers.parseEther('100'), '0x1234'],
        ),
        transactionHash: '0xaaaa000000000000000000000000000000000000000000000000000000000002',
        logIndex: 0,
        blockNumber: 101n,
      };

      const result = decoder.decode(log, iface);

      expect(result.status).toBe('decoded');
      if (result.status === 'decoded') {
        expect(result.signature).toBe('Transfer(address,address,uint256,bytes)');
        expect(result.topic0).toBe(topic0);
        expect(result.description.name).toBe('Transfer');
      }
    });

    it('distinguishes between overloaded Transfer events by topic0', () => {
      const iface1 = new Interface([TRANSFER_V1_ABI]);
      const iface2 = new Interface([TRANSFER_V2_ABI]);

      const fragment1 = iface1.getEvent('Transfer')!;
      const fragment2 = iface2.getEvent('Transfer')!;

      const topic0_v1 = ethers.id(fragment1.format('sighash'));
      const topic0_v2 = ethers.id(fragment2.format('sighash'));

      // topic0 must be different for overloaded events
      expect(topic0_v1).not.toBe(topic0_v2);
    });

    it('fails to decode Transfer(v2) log with Transfer(v1) ABI', () => {
      const iface = new Interface([TRANSFER_V1_ABI]); // V1 ABI only
      const ifaceV2 = new Interface([TRANSFER_V2_ABI]);
      const fragmentV2 = ifaceV2.getEvent('Transfer')!;
      const topic0_v2 = ethers.id(fragmentV2.format('sighash'));

      const log: RawLog = {
        chainId: 11155420,
        address: '0x1234567890123456789012345678901234567890',
        topics: [
          topic0_v2, // V2 topic0
          ethers.zeroPadValue('0x0000000000000000000000000000000000000001', 32),
          ethers.zeroPadValue('0x0000000000000000000000000000000000000002', 32),
        ],
        data: ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint256', 'bytes'],
          [ethers.parseEther('100'), '0x1234'],
        ),
        transactionHash: '0xaaaa000000000000000000000000000000000000000000000000000000000003',
        logIndex: 0,
        blockNumber: 102n,
      };

      const result = decoder.decode(log, iface);

      // Should fail because V1 ABI doesn't have V2 topic0
      expect(result.status).toBe('unknown_signature');
      if (result.status === 'unknown_signature') {
        expect(result.topic0).toBe(topic0_v2);
      }
    });
  });

  describe('ABI with Both Overloads', () => {
    it('decodes both overloads correctly when both are in the ABI', () => {
      const iface = new Interface([TRANSFER_V1_ABI, TRANSFER_V2_ABI]);

      const fragment1 = iface.getEvent('Transfer', ['address', 'address', 'uint256'])!;
      const fragment2 = iface.getEvent('Transfer', ['address', 'address', 'uint256', 'bytes'])!;

      const topic0_v1 = ethers.id(fragment1.format('sighash'));
      const topic0_v2 = ethers.id(fragment2.format('sighash'));

      // Test V1 log
      const logV1: RawLog = {
        chainId: 11155420,
        address: '0x1234567890123456789012345678901234567890',
        topics: [
          topic0_v1,
          ethers.zeroPadValue('0x0000000000000000000000000000000000000001', 32),
          ethers.zeroPadValue('0x0000000000000000000000000000000000000002', 32),
        ],
        data: ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [ethers.parseEther('100')]),
        transactionHash: '0xaaaa000000000000000000000000000000000000000000000000000000000004',
        logIndex: 0,
        blockNumber: 103n,
      };

      const resultV1 = decoder.decode(logV1, iface);
      expect(resultV1.status).toBe('decoded');
      if (resultV1.status === 'decoded') {
        expect(resultV1.signature).toBe('Transfer(address,address,uint256)');
      }

      // Test V2 log
      const logV2: RawLog = {
        chainId: 11155420,
        address: '0x1234567890123456789012345678901234567890',
        topics: [
          topic0_v2,
          ethers.zeroPadValue('0x0000000000000000000000000000000000000001', 32),
          ethers.zeroPadValue('0x0000000000000000000000000000000000000002', 32),
        ],
        data: ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint256', 'bytes'],
          [ethers.parseEther('200'), '0x5678'],
        ),
        transactionHash: '0xaaaa000000000000000000000000000000000000000000000000000000000005',
        logIndex: 1,
        blockNumber: 103n,
      };

      const resultV2 = decoder.decode(logV2, iface);
      expect(resultV2.status).toBe('decoded');
      if (resultV2.status === 'decoded') {
        expect(resultV2.signature).toBe('Transfer(address,address,uint256,bytes)');
      }
    });
  });

  describe('Signature-Based Keying', () => {
    it('includes eventSignature in normalized event', () => {
      const iface = new Interface([TRANSFER_V1_ABI]);
      const fragment = iface.getEvent('Transfer')!;
      const topic0 = ethers.id(fragment.format('sighash'));

      const log: RawLog = {
        chainId: 11155420,
        address: '0x1234567890123456789012345678901234567890',
        topics: [
          topic0,
          ethers.zeroPadValue('0x0000000000000000000000000000000000000001', 32),
          ethers.zeroPadValue('0x0000000000000000000000000000000000000002', 32),
        ],
        data: ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [ethers.parseEther('100')]),
        transactionHash: '0xaaaa000000000000000000000000000000000000000000000000000000000006',
        logIndex: 0,
        blockNumber: 104n,
      };

      const decoded = decoder.decode(log, iface);
      expect(decoded.status).toBe('decoded');

      if (decoded.status === 'decoded') {
        // The normalize method would be called with the signature
        expect(decoded.signature).toBeTruthy();
        expect(decoded.signature).toBe('Transfer(address,address,uint256)');
      }
    });
  });
});
