import { Claim, ClaimState } from './claim.entity';

describe('Claim Entity', () => {
  let claim: Claim;

  beforeEach(() => {
    claim = new Claim();
    claim.id = 'test-claim-id';
    claim.title = 'Test Claim';
    claim.content = 'Test content';
    claim.resolvedVerdict = null;
    claim.confidenceScore = null;
    claim.finalized = false;
  });

  describe('getCurrentState', () => {
    it('should return PENDING for new claim', () => {
      expect(claim.getCurrentState()).toBe(ClaimState.PENDING);
    });

    it('should return RESOLVED when verdict and confidence are set but not finalized', () => {
      claim.resolvedVerdict = true;
      claim.confidenceScore = 0.85;
      claim.finalized = false;

      expect(claim.getCurrentState()).toBe(ClaimState.RESOLVED);
    });

    it('should return FINALIZED when finalized flag is true', () => {
      claim.resolvedVerdict = true;
      claim.confidenceScore = 0.85;
      claim.finalized = true;

      expect(claim.getCurrentState()).toBe(ClaimState.FINALIZED);
    });

    it('should return PENDING when only verdict is set', () => {
      claim.resolvedVerdict = true;
      claim.confidenceScore = null;

      expect(claim.getCurrentState()).toBe(ClaimState.PENDING);
    });

    it('should return PENDING when only confidence is set', () => {
      claim.resolvedVerdict = null;
      claim.confidenceScore = 0.85;

      expect(claim.getCurrentState()).toBe(ClaimState.PENDING);
    });
  });

  describe('transitionTo - Valid Transitions', () => {
    describe('PENDING → RESOLVED', () => {
      it('should transition from PENDING to RESOLVED with valid data', () => {
        claim.transitionTo(ClaimState.RESOLVED, {
          verdict: true,
          confidence: 0.85,
        });

        expect(claim.resolvedVerdict).toBe(true);
        expect(claim.confidenceScore).toBe(0.85);
        expect(claim.finalized).toBe(false);
        expect(claim.getCurrentState()).toBe(ClaimState.RESOLVED);
      });

      it('should throw error when transitioning PENDING → RESOLVED without verdict', () => {
        expect(() => {
          claim.transitionTo(ClaimState.RESOLVED, {
            confidence: 0.85,
          });
        }).toThrow('PENDING → RESOLVED requires both verdict and confidence data');
      });

      it('should throw error when transitioning PENDING → RESOLVED without confidence', () => {
        expect(() => {
          claim.transitionTo(ClaimState.RESOLVED, {
            verdict: true,
          });
        }).toThrow('PENDING → RESOLVED requires both verdict and confidence data');
      });

      it('should throw error when transitioning PENDING → RESOLVED without data', () => {
        expect(() => {
          claim.transitionTo(ClaimState.RESOLVED);
        }).toThrow('PENDING → RESOLVED requires both verdict and confidence data');
      });
    });

    describe('PENDING → FINALIZED', () => {
      it('should transition from PENDING to FINALIZED with valid data', () => {
        claim.transitionTo(ClaimState.FINALIZED, {
          verdict: false,
          confidence: 0.92,
        });

        expect(claim.resolvedVerdict).toBe(false);
        expect(claim.confidenceScore).toBe(0.92);
        expect(claim.finalized).toBe(true);
        expect(claim.getCurrentState()).toBe(ClaimState.FINALIZED);
      });

      it('should throw error when transitioning PENDING → FINALIZED without verdict', () => {
        expect(() => {
          claim.transitionTo(ClaimState.FINALIZED, {
            confidence: 0.92,
          });
        }).toThrow('PENDING → FINALIZED requires both verdict and confidence data');
      });

      it('should throw error when transitioning PENDING → FINALIZED without confidence', () => {
        expect(() => {
          claim.transitionTo(ClaimState.FINALIZED, {
            verdict: false,
          });
        }).toThrow('PENDING → FINALIZED requires both verdict and confidence data');
      });
    });

    describe('RESOLVED → RESOLVED', () => {
      beforeEach(() => {
        claim.resolvedVerdict = true;
        claim.confidenceScore = 0.75;
        claim.finalized = false;
      });

      it('should allow updating verdict in RESOLVED state', () => {
        claim.transitionTo(ClaimState.RESOLVED, {
          verdict: false,
        });

        expect(claim.resolvedVerdict).toBe(false);
        expect(claim.confidenceScore).toBe(0.75); // unchanged
        expect(claim.finalized).toBe(false);
      });

      it('should allow updating confidence in RESOLVED state', () => {
        claim.transitionTo(ClaimState.RESOLVED, {
          confidence: 0.95,
        });

        expect(claim.resolvedVerdict).toBe(true); // unchanged
        expect(claim.confidenceScore).toBe(0.95);
        expect(claim.finalized).toBe(false);
      });

      it('should allow updating both verdict and confidence in RESOLVED state', () => {
        claim.transitionTo(ClaimState.RESOLVED, {
          verdict: false,
          confidence: 0.88,
        });

        expect(claim.resolvedVerdict).toBe(false);
        expect(claim.confidenceScore).toBe(0.88);
        expect(claim.finalized).toBe(false);
      });
    });

    describe('RESOLVED → FINALIZED', () => {
      beforeEach(() => {
        claim.resolvedVerdict = true;
        claim.confidenceScore = 0.75;
        claim.finalized = false;
      });

      it('should transition from RESOLVED to FINALIZED without additional data', () => {
        claim.transitionTo(ClaimState.FINALIZED);

        expect(claim.resolvedVerdict).toBe(true);
        expect(claim.confidenceScore).toBe(0.75);
        expect(claim.finalized).toBe(true);
        expect(claim.getCurrentState()).toBe(ClaimState.FINALIZED);
      });

      it('should allow updating verdict when transitioning RESOLVED → FINALIZED', () => {
        claim.transitionTo(ClaimState.FINALIZED, {
          verdict: false,
        });

        expect(claim.resolvedVerdict).toBe(false);
        expect(claim.confidenceScore).toBe(0.75);
        expect(claim.finalized).toBe(true);
      });

      it('should allow updating confidence when transitioning RESOLVED → FINALIZED', () => {
        claim.transitionTo(ClaimState.FINALIZED, {
          confidence: 0.99,
        });

        expect(claim.resolvedVerdict).toBe(true);
        expect(claim.confidenceScore).toBe(0.99);
        expect(claim.finalized).toBe(true);
      });

      it('should allow updating both when transitioning RESOLVED → FINALIZED', () => {
        claim.transitionTo(ClaimState.FINALIZED, {
          verdict: false,
          confidence: 0.99,
        });

        expect(claim.resolvedVerdict).toBe(false);
        expect(claim.confidenceScore).toBe(0.99);
        expect(claim.finalized).toBe(true);
      });
    });
  });

  describe('transitionTo - Invalid Transitions', () => {
    describe('Transitions to PENDING', () => {
      it('should throw error when transitioning from PENDING to PENDING', () => {
        expect(() => {
          claim.transitionTo(ClaimState.PENDING);
        }).toThrow('Cannot transition to PENDING from PENDING');
      });

      it('should throw error when transitioning from RESOLVED to PENDING', () => {
        claim.resolvedVerdict = true;
        claim.confidenceScore = 0.85;

        expect(() => {
          claim.transitionTo(ClaimState.PENDING);
        }).toThrow('Cannot transition to PENDING from RESOLVED');
      });

      it('should throw error when transitioning from FINALIZED to PENDING', () => {
        claim.resolvedVerdict = true;
        claim.confidenceScore = 0.85;
        claim.finalized = true;

        expect(() => {
          claim.transitionTo(ClaimState.PENDING);
        }).toThrow('Cannot transition from FINALIZED state');
      });
    });

    describe('Transitions from FINALIZED', () => {
      beforeEach(() => {
        claim.resolvedVerdict = true;
        claim.confidenceScore = 0.85;
        claim.finalized = true;
      });

      it('should throw error when transitioning from FINALIZED to PENDING', () => {
        expect(() => {
          claim.transitionTo(ClaimState.PENDING);
        }).toThrow('Cannot transition from FINALIZED state. Claim test-claim-id is immutable');
      });

      it('should throw error when transitioning from FINALIZED to RESOLVED', () => {
        expect(() => {
          claim.transitionTo(ClaimState.RESOLVED, {
            verdict: false,
            confidence: 0.90,
          });
        }).toThrow('Cannot transition from FINALIZED state. Claim test-claim-id is immutable');
      });

      it('should throw error when transitioning from FINALIZED to FINALIZED', () => {
        expect(() => {
          claim.transitionTo(ClaimState.FINALIZED);
        }).toThrow('Cannot transition from FINALIZED state. Claim test-claim-id is immutable');
      });
    });

    describe('Invalid target states', () => {
      it('should throw error for invalid target state', () => {
        expect(() => {
          claim.transitionTo('INVALID_STATE' as any);
        }).toThrow('Invalid target state: INVALID_STATE');
      });
    });
  });

  describe('transitionTo - Edge Cases', () => {
    it('should handle verdict=false correctly', () => {
      claim.transitionTo(ClaimState.RESOLVED, {
        verdict: false,
        confidence: 0.85,
      });

      expect(claim.resolvedVerdict).toBe(false);
      expect(claim.confidenceScore).toBe(0.85);
    });

    it('should handle confidence=0 correctly', () => {
      claim.transitionTo(ClaimState.RESOLVED, {
        verdict: true,
        confidence: 0,
      });

      expect(claim.resolvedVerdict).toBe(true);
      expect(claim.confidenceScore).toBe(0);
    });

    it('should handle confidence=1 correctly', () => {
      claim.transitionTo(ClaimState.RESOLVED, {
        verdict: true,
        confidence: 1,
      });

      expect(claim.resolvedVerdict).toBe(true);
      expect(claim.confidenceScore).toBe(1);
    });

    it('should maintain state consistency across multiple transitions', () => {
      // PENDING → RESOLVED
      claim.transitionTo(ClaimState.RESOLVED, {
        verdict: true,
        confidence: 0.75,
      });
      expect(claim.getCurrentState()).toBe(ClaimState.RESOLVED);

      // RESOLVED → RESOLVED (update)
      claim.transitionTo(ClaimState.RESOLVED, {
        confidence: 0.85,
      });
      expect(claim.getCurrentState()).toBe(ClaimState.RESOLVED);
      expect(claim.confidenceScore).toBe(0.85);

      // RESOLVED → FINALIZED
      claim.transitionTo(ClaimState.FINALIZED);
      expect(claim.getCurrentState()).toBe(ClaimState.FINALIZED);

      // Cannot transition from FINALIZED
      expect(() => {
        claim.transitionTo(ClaimState.RESOLVED, {
          verdict: false,
          confidence: 0.90,
        });
      }).toThrow('Cannot transition from FINALIZED state');
    });
  });
});
