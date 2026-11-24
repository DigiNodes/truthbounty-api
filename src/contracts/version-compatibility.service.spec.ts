import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { VersionCompatibilityService } from './version-compatibility.service';

describe('VersionCompatibilityService', () => {
  let service: VersionCompatibilityService;
  let configService: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VersionCompatibilityService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'NODE_ENV') return 'development';
              return undefined;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<VersionCompatibilityService>(VersionCompatibilityService);
    configService = module.get<ConfigService>(ConfigService);
  });

  describe('validateDecoderCompatibility', () => {
    it('passes when decoder and manifest versions match exactly', () => {
      const result = service.validateDecoderCompatibility(
        '2.0.0',
        'rel-opsepolia-20261015-v2',
        '2.0.0',
      );

      expect(result.compatible).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.pinnedVersion).toBe('2.0.0');
      expect(result.decoderVersion).toBe('2.0.0');
    });

    it('fails when decoder version does not match manifest version', () => {
      const result = service.validateDecoderCompatibility(
        '2.0.0',
        'rel-opsepolia-20261015-v2',
        '1.9.0',
      );

      expect(result.compatible).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Version mismatch');
      expect(result.errors[0]).toContain('1.9.0');
      expect(result.errors[0]).toContain('2.0.0');
    });

    it('fails when manifest version is missing', () => {
      const result = service.validateDecoderCompatibility('', 'rel-test-v1', '2.0.0');

      expect(result.compatible).toBe(false);
      expect(result.errors.some((e) => e.includes('Manifest version'))).toBe(true);
    });

    it('fails when decoder version is missing', () => {
      const result = service.validateDecoderCompatibility('2.0.0', 'rel-test-v1', '');

      expect(result.compatible).toBe(false);
      expect(result.errors.some((e) => e.includes('Decoder version'))).toBe(true);
    });

    it('warns when release ID format is non-standard', () => {
      const result = service.validateDecoderCompatibility(
        '2.0.0',
        'not-a-standard-format',
        '2.0.0',
      );

      expect(result.compatible).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('does not follow expected format');
    });

    it('warns when release ID is missing', () => {
      const result = service.validateDecoderCompatibility('2.0.0', undefined, '2.0.0');

      expect(result.compatible).toBe(true);
      expect(result.warnings.some((w) => w.includes('releaseId'))).toBe(true);
    });

    it('warns when using pre-release version in production', () => {
      jest.spyOn(configService, 'get').mockReturnValue('production');

      const result = service.validateDecoderCompatibility(
        '2.0.0-rc.3',
        'rel-test-v1',
        '2.0.0-rc.3',
      );

      expect(result.compatible).toBe(true);
      expect(result.warnings.some((w) => w.includes('pre-release'))).toBe(true);
    });

    it('allows pre-release versions in development', () => {
      jest.spyOn(configService, 'get').mockReturnValue('development');

      const result = service.validateDecoderCompatibility(
        '2.0.0-rc.3',
        'rel-test-v1',
        '2.0.0-rc.3',
      );

      expect(result.compatible).toBe(true);
      expect(result.warnings.every((w) => !w.includes('pre-release'))).toBe(true);
    });

    it('validates release ID format correctly for valid IDs', () => {
      const result = service.validateDecoderCompatibility(
        '2.0.0',
        'rel-opsepolia-20261015-v2',
        '2.0.0',
      );

      expect(result.compatible).toBe(true);
      expect(result.warnings.every((w) => !w.includes('format'))).toBe(true);
    });
  });

  describe('isCompatibleArtifactVersion', () => {
    it('returns true when versions match exactly', () => {
      const result = service.isCompatibleArtifactVersion('2.0.0', '2.0.0');
      expect(result).toBe(true);
    });

    it('returns false when versions do not match', () => {
      const result = service.isCompatibleArtifactVersion('2.0.0', '1.9.0');
      expect(result).toBe(false);
    });

    it('handles whitespace trimming', () => {
      const result = service.isCompatibleArtifactVersion('  2.0.0  ', '2.0.0');
      expect(result).toBe(true);
    });

    it('returns false when artifact version is missing', () => {
      const result = service.isCompatibleArtifactVersion('', '2.0.0');
      expect(result).toBe(false);
    });

    it('returns false when expected version is missing', () => {
      const result = service.isCompatibleArtifactVersion('2.0.0', '');
      expect(result).toBe(false);
    });

    it('returns false for null versions', () => {
      const result = service.isCompatibleArtifactVersion(null as any, '2.0.0');
      expect(result).toBe(false);
    });
  });

  describe('validateReleaseBinding', () => {
    it('passes when all required fields are present', () => {
      const manifest = {
        version: '2.0.0',
        releaseId: 'rel-opsepolia-20261015-v2',
        chainId: 11155420,
        publishedAt: '2026-10-15T16:56:32.141Z',
        manifestChecksum: 'f183dd1270bacc47f49f05f3d2ac0c8f021b41138da06d822377a2845cddb22f',
        contracts: [
          { deployBlock: 24850000, abiChecksum: 'abc123' },
        ],
      };

      const result = service.validateReleaseBinding(manifest);

      expect(result.compatible).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('fails when version is missing', () => {
      const manifest = {
        releaseId: 'rel-test-v1',
        chainId: 10,
        publishedAt: '2026-10-15T16:56:32.141Z',
        manifestChecksum: 'abc123',
      };

      const result = service.validateReleaseBinding(manifest);

      expect(result.compatible).toBe(false);
      expect(result.errors.some((e) => e.includes('version'))).toBe(true);
    });

    it('fails when releaseId is missing', () => {
      const manifest = {
        version: '2.0.0',
        chainId: 10,
        publishedAt: '2026-10-15T16:56:32.141Z',
        manifestChecksum: 'abc123',
      };

      const result = service.validateReleaseBinding(manifest);

      expect(result.compatible).toBe(false);
      expect(result.errors.some((e) => e.includes('releaseId'))).toBe(true);
    });

    it('fails when chainId is missing', () => {
      const manifest = {
        version: '2.0.0',
        releaseId: 'rel-test-v1',
        publishedAt: '2026-10-15T16:56:32.141Z',
        manifestChecksum: 'abc123',
      };

      const result = service.validateReleaseBinding(manifest);

      expect(result.compatible).toBe(false);
      expect(result.errors.some((e) => e.includes('chainId'))).toBe(true);
    });

    it('fails when publishedAt is missing', () => {
      const manifest = {
        version: '2.0.0',
        releaseId: 'rel-test-v1',
        chainId: 10,
        manifestChecksum: 'abc123',
      };

      const result = service.validateReleaseBinding(manifest);

      expect(result.compatible).toBe(false);
      expect(result.errors.some((e) => e.includes('publishedAt'))).toBe(true);
    });

    it('fails when manifestChecksum is missing', () => {
      const manifest = {
        version: '2.0.0',
        releaseId: 'rel-test-v1',
        chainId: 10,
        publishedAt: '2026-10-15T16:56:32.141Z',
      };

      const result = service.validateReleaseBinding(manifest);

      expect(result.compatible).toBe(false);
      expect(result.errors.some((e) => e.includes('manifestChecksum'))).toBe(true);
    });

    it('fails when contract deployBlock is missing', () => {
      const manifest = {
        version: '2.0.0',
        releaseId: 'rel-test-v1',
        chainId: 10,
        publishedAt: '2026-10-15T16:56:32.141Z',
        manifestChecksum: 'abc123',
        contracts: [{ abiChecksum: 'def456' }],
      };

      const result = service.validateReleaseBinding(manifest);

      expect(result.compatible).toBe(false);
      expect(result.errors.some((e) => e.includes('deployBlock'))).toBe(true);
    });

    it('fails when contract abiChecksum is missing', () => {
      const manifest = {
        version: '2.0.0',
        releaseId: 'rel-test-v1',
        chainId: 10,
        publishedAt: '2026-10-15T16:56:32.141Z',
        manifestChecksum: 'abc123',
        contracts: [{ deployBlock: 12345 }],
      };

      const result = service.validateReleaseBinding(manifest);

      expect(result.compatible).toBe(false);
      expect(result.errors.some((e) => e.includes('abiChecksum'))).toBe(true);
    });

    it('validates multiple contracts', () => {
      const manifest = {
        version: '2.0.0',
        releaseId: 'rel-test-v1',
        chainId: 10,
        publishedAt: '2026-10-15T16:56:32.141Z',
        manifestChecksum: 'abc123',
        contracts: [
          { deployBlock: 12345, abiChecksum: 'abc' },
          { deployBlock: 12346, abiChecksum: 'def' },
          { deployBlock: -1, abiChecksum: 'ghi' }, // invalid
        ],
      };

      const result = service.validateReleaseBinding(manifest);

      expect(result.compatible).toBe(false);
      expect(result.errors.some((e) => e.includes('Contract[2]'))).toBe(true);
    });
  });

  describe('logPinnedRelease', () => {
    it('logs pinned release information', () => {
      const logSpy = jest.spyOn(service['logger'], 'log');

      service.logPinnedRelease('2.0.0', 'rel-opsepolia-20261015-v2', 11155420, 4);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Decoder locked to pinned manifest'),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('rel-opsepolia-20261015-v2'),
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('2.0.0'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('11155420'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('4 contract'));
    });

    it('handles missing release ID gracefully', () => {
      const logSpy = jest.spyOn(service['logger'], 'log');

      service.logPinnedRelease('2.0.0', undefined, 10, 3);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('no explicit releaseId'),
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('2.0.0'));
    });
  });
});
