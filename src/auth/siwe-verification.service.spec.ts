// src/auth/siwe-verification.service.spec.ts
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SiweVerificationService } from './siwe-verification.service';
import { SiweService } from './services/siwe.service';
import { SiweNonceService } from './siwe-nonce.service';
import { SiweVerifyResult } from './types/siwe.types';

describe('SiweVerificationService (#609)', () => {
  let service: SiweVerificationService;
  let dataSource: Partial<DataSource>;
  let siweService: Partial<SiweService>;
  let siweNonceService: Partial<SiweNonceService>;

  const VALID_ADDRESS = '0x1111111111111111111111111111111111111111';
  const VALID_NONCE = 'abc123def456';
  const SIGNATURE = '0x1234567890abcdef';
  const MESSAGE = 'sample-siwe-message';

  beforeEach(() => {
    dataSource = {
      query: jest.fn().mockResolvedValue([{ id: 1 }]),
    };

    siweService = {
      verifySiwe: jest.fn().mockResolvedValue({
        success: true,
        data: {
          address: VALID_ADDRESS,
          nonce: VALID_NONCE,
          domain: 'truthbounty.app',
          uri: 'https://truthbounty.app',
          version: '1',
          chainId: 10,
          issuedAt: new Date().toISOString(),
          rawMessage: MESSAGE,
        },
      } as SiweVerifyResult),
    };

    siweNonceService = {
      consumeNonce: jest.fn().mockResolvedValue(undefined),
    };

    service = new SiweVerificationService(
      dataSource as DataSource,
      siweService as SiweService,
      siweNonceService as SiweNonceService,
    );
  });

  it('delegates replay protection to SiweNonceService.consumeNonce', async () => {
    const address = await service.verifySiweMessage(
      MESSAGE,
      SIGNATURE,
      VALID_NONCE,
    );

    expect(address).toBe(VALID_ADDRESS.toLowerCase());
    expect(siweNonceService.consumeNonce).toHaveBeenCalledWith(
      VALID_ADDRESS,
      VALID_NONCE,
    );
  });

  it('rejects when client nonce does not match parsed message nonce', async () => {
    await expect(
      service.verifySiweMessage(MESSAGE, SIGNATURE, 'mismatchedNonce123'),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('fails closed when SiweService rejects the signature or parameters', async () => {
    (siweService.verifySiwe as jest.Mock).mockResolvedValueOnce({
      success: false,
      error: 'DOMAIN_MISMATCH',
    });

    await expect(
      service.verifySiweMessage(MESSAGE, SIGNATURE, VALID_NONCE),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('fails closed when SiweNonceService rejects replay', async () => {
    (siweNonceService.consumeNonce as jest.Mock).mockRejectedValueOnce(
      new UnauthorizedException(
        'Nonce has already been used (replay attack prevented)',
      ),
    );

    await expect(
      service.verifySiweMessage(MESSAGE, SIGNATURE, VALID_NONCE),
    ).rejects.toThrow(UnauthorizedException);
  });
});
