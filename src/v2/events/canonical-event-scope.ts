import { getRuntimeConfig } from '../../config/runtime-config';

export interface CanonicalEventScope {
  chainId: number;
}

export function getCanonicalEventScope(): CanonicalEventScope {
  const config = getRuntimeConfig();
  const CHAIN_ID =
    config.NODE_ENV === 'test' && !process.env.CHAIN_ID
      ? 10
      : config.CHAIN_ID;
  if (CHAIN_ID !== 10 && CHAIN_ID !== 11155420) {
    throw new Error(`Unsupported canonical event chain: ${CHAIN_ID}`);
  }
  return { chainId: CHAIN_ID };
}

export function scopedProjectorName(
  projectorName: string,
  chainId: number,
): string {
  return `${projectorName}:${chainId}`;
}
