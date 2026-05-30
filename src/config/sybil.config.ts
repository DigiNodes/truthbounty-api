import { registerAs } from '@nestjs/config';

export default registerAs('sybil', () => ({
  minClaimsForAccuracyScore: parseInt(
    process.env.SYBIL_MIN_CLAIMS_FOR_ACCURACY_SCORE ?? '5',
    10,
  ),
}));
