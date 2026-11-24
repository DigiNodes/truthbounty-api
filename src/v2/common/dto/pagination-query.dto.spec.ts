import { describe, expect, it } from '@jest/globals';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { PaginationQueryDto } from './pagination-query.dto';

describe('PaginationQueryDto', () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  const validate = async (value: Record<string, unknown>) =>
    pipe.transform(value, {
      type: 'query',
      metatype: PaginationQueryDto,
      data: '',
    });

  it('uses the default page limit when limit is omitted', async () => {
    const result = await validate({});

    expect(result).toBeInstanceOf(PaginationQueryDto);
    expect((result as PaginationQueryDto).limit).toBe(20);
  });

  it('accepts the minimum and maximum page limits', async () => {
    await expect(validate({ limit: '1' })).resolves.toMatchObject({
      limit: 1,
    });

    await expect(validate({ limit: '100' })).resolves.toMatchObject({
      limit: 100,
    });
  });

  it.each(['0', '-1', '101'])(
    'rejects an out-of-range limit: %s',
    async (limit) => {
      await expect(validate({ limit })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    },
  );

  it('rejects malformed numeric input instead of partially parsing it', async () => {
    await expect(validate({ limit: '20abc' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects unknown query fields', async () => {
    await expect(
      validate({ limit: '20', unexpected: 'value' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts an optional string cursor', async () => {
    const result = await validate({
      cursor: 'opaque-cursor',
      limit: '20',
    });

    expect(result).toMatchObject({
      cursor: 'opaque-cursor',
      limit: 20,
    });
  });
});
