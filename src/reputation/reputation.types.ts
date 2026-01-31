export const MAX_SCORE = 100;
export const BASE_DELTA = 2; // base reputation points per correct verification
export const STAKE_CAP = 1000; // stake units beyond this are ignored for direct score influence
export const MIN_DAMPEN = 0.1; // minimum dampening factor for high-rep increases
export const MAX_POS_DELTA = 10; // maximum single positive change
export const MAX_NEG_DELTA = 15; // maximum single negative change
export const ALPHA = 1; // Bayesian prior for reliability calculation

export interface ReputationDeltaParams {
  oldScore: number; // 0..100
  totalVerifications: number; // verifier historical totals
  correctVerifications: number; // verifier historical correct count
  stakeAmount: number; // stake amount (protocol-native units)
  isCorrect: boolean; // whether the verifier matched final outcome
}
