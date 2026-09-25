import { registerAs } from '@nestjs/config';

/**
 * Canonical source of truth for finality/confirmations inputs.
 *
 * The codebase historically grew three independently-named env vars for the
 * same "confirmations" concept (CONFIRMATIONS_REQUIRED, REQUIRED_CONFIRMATIONS,
 * BLOCKCHAIN_CONFIRMATION_DEPTH), none of them validated at startup. This
 * config introduces a single canonical pair of env vars
 * (FINALITY_SAFE_CONFIRMATIONS / FINALITY_FINALIZED_CONFIRMATIONS) while
 * falling back to the legacy names so existing deployments keep working
 * without an env change.
 */
export default registerAs('finalityPolicy', () => ({
  chainId: parseInt(process.env.CHAIN_ID ?? '10', 10),
  allowedChainIds: parseAllowedChainIds(process.env.FINALITY_ALLOWED_CHAIN_IDS),
  safeConfirmations: parseInt(
    process.env.FINALITY_SAFE_CONFIRMATIONS ??
      process.env.BLOCKCHAIN_CONFIRMATION_DEPTH ??
      '1',
    10,
  ),
  finalizedConfirmations: parseInt(
    process.env.FINALITY_FINALIZED_CONFIRMATIONS ??
      process.env.CONFIRMATIONS_REQUIRED ??
      process.env.REQUIRED_CONFIRMATIONS ??
      '12',
    10,
  ),
}));

/** Optimism mainnet (10) and Optimism Sepolia (11155420) by default. */
const DEFAULT_ALLOWED_CHAIN_IDS = [10, 11155420];

function parseAllowedChainIds(raw: string | undefined): number[] {
  if (!raw) return DEFAULT_ALLOWED_CHAIN_IDS;
  const parsed = raw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return parsed.length > 0 ? parsed : DEFAULT_ALLOWED_CHAIN_IDS;
}
