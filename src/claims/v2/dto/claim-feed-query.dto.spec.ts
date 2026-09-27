import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from '@jest/globals';
import { ClaimFeedQueryDto } from './claim-feed-query.dto';

describe('ClaimFeedQueryDto', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  const validate = async (value: Record<string, unknown>) =>
    pipe.transform(value, {
      type: 'query',
      metatype: ClaimFeedQueryDto,
      data: '',
    });

  it('accepts a valid Ethereum creator address', async () => {
    const result = await validate({
      creator: '0x1111111111111111111111111111111111111111',
    });

    expect(result).toBeInstanceOf(ClaimFeedQueryDto);
    expect((result as ClaimFeedQueryDto).creator).toBe(
      '0x1111111111111111111111111111111111111111',
    );
  });

  it.each([
    '',
    'not-an-address',
    '0x1234',
    '0xgggggggggggggggggggggggggggggggggggggggg',
  ])('rejects an invalid creator address: %s', async (creator) => {
    await expect(validate({ creator })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects unknown query fields', async () => {
    await expect(
      validate({
        creator: '0x1111111111111111111111111111111111111111',
        unexpected: 'value',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
