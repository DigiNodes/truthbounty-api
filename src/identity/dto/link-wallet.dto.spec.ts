import { validate } from 'class-validator';
import { LinkWalletDto } from './link-wallet.dto';

function createDto(address: string): LinkWalletDto {
  const dto = new LinkWalletDto();
  dto.address = address;
  dto.chain = 'ethereum';
  dto.signature = '0xsignature';
  dto.message = 'Link this wallet';
  return dto;
}

describe('LinkWalletDto', () => {
  it('accepts valid Ethereum addresses', async () => {
    const errors = await validate(
      createDto('0x52908400098527886E0F7030069857D2E4169EE7'),
    );

    expect(errors).toHaveLength(0);
  });

  it.each([
    '52908400098527886E0F7030069857D2E4169EE7',
    '0x52908400098527886E0F7030069857D2E4169EE',
    '0x52908400098527886E0F7030069857D2E4169EE71',
    '0x52908400098527886E0F7030069857D2E4169EGG',
  ])('rejects invalid Ethereum address %s', async (address) => {
    const errors = await validate(createDto(address));
    const addressError = errors.find((error) => error.property === 'address');

    expect(addressError?.constraints).toHaveProperty(
      'isEthereumAddress',
      'address must be a valid Ethereum address',
    );
  });
});
