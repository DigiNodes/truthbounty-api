import { registerAs } from '@nestjs/config';
import { getRuntimeConfig } from './runtime-config';

export default registerAs('finalityPolicy', () => {
  const config = getRuntimeConfig();
  return {
    chainId: config.CHAIN_ID,
    allowedChainIds: config.FINALITY_ALLOWED_CHAIN_IDS!.map(Number),
    safeConfirmations: config.FINALITY_SAFE_CONFIRMATIONS,
    finalizedConfirmations: config.FINALITY_FINALIZED_CONFIRMATIONS,
  };
});
