import { registerAs } from '@nestjs/config';
import { getRuntimeConfig } from './runtime-config';

export default registerAs('sybil', () => ({
  minClaimsForAccuracyScore:
    getRuntimeConfig().SYBIL_MIN_CLAIMS_FOR_ACCURACY_SCORE,
}));
