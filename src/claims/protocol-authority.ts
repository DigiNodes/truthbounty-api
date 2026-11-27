import { GoneException } from '@nestjs/common';

export const CANONICAL_CLAIM_READ_MODEL_PATH = '/api/v2/claim-read-models';

export function rejectLegacyProtocolOperation(
  message: string,
  canonicalPath = CANONICAL_CLAIM_READ_MODEL_PATH,
): never {
  throw new GoneException({
    statusCode: 410,
    error: 'Gone',
    code: 'CANONICAL_CHAIN_STATE_REQUIRED',
    message,
    canonicalPath,
    nextStep:
      'Submit protocol state changes from the user wallet, then wait for the finalized event to be indexed.',
  });
}
