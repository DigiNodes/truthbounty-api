import { Claim } from '../entities/claim.entity';
import { CreateClaimDto } from '../dto/create-claim.dto';

/**
 * Factory for creating Claim entities and DTOs for testing and seeding
 */
export class ClaimFactory {
  /**
   * Create a mock CreateClaimDto with realistic data
   */
  static createCreateClaimDto(overrides: Partial<CreateClaimDto> = {}): CreateClaimDto {
    return {
      title: 'Test claim about climate change',
      content: 'Recent scientific studies indicate that global temperature rise is exceeding previous climate models by approximately 0.2°C per decade.',
      source: 'https://example.com/scientific-study',
      metadata: {
        category: 'climate',
        tags: ['science', 'environment', 'climate-change'],
        severity: 'high',
      },
      ...overrides,
    };
  }

  /**
   * Create a mock Claim entity with resolved verdict and confidence for testing
   */
  static createClaim(overrides: Partial<Claim> = {}): Claim {
    const dto = ClaimFactory.createCreateClaimDto();
    return {
      id: '00000000-0000-0000-0000-000000000000',
      title: dto.title,
      content: dto.content,
      source: dto.source,
      metadata: dto.metadata,
      resolvedVerdict: Math.random() > 0.5,
      confidenceScore: Math.random() * 0.9 + 0.1,
      finalized: false,
      createdAt: new Date(),
      resolvedAt: null,
      evidences: [],
      ...overrides,
    } as Claim;
  }

  /**
   * Create multiple mock claims for load testing
   */
  static createManyClaims(count: number): Claim[] {
    return Array.from({ length: count }, (_, index) => 
      ClaimFactory.createClaim({
        id: `00000000-0000-0000-0000-${index.toString().padStart(12, '0')}`,
        title: `Test claim ${index + 1}`,
        content: `Content for test claim number ${index + 1}`,
      })
    );
  }

  /**
   * Create a claim with specific verdict and confidence for testing edge cases
   */
  static createClaimWithVerdict(verdict: boolean, confidence: number): Claim {
    return ClaimFactory.createClaim({
      resolvedVerdict: verdict,
      confidenceScore: confidence,
      finalized: true,
    });
  }

  /**
   * Create claims with varying confidence scores for testing confidence calculations
   */
  static createClaimsWithConfidenceScores(): Claim[] {
    return [
      ClaimFactory.createClaimWithVerdict(true, 0.95),
      ClaimFactory.createClaimWithVerdict(false, 0.85),
      ClaimFactory.createClaimWithVerdict(true, 0.75),
      ClaimFactory.createClaimWithVerdict(false, 0.60),
      ClaimFactory.createClaimWithVerdict(true, 0.45),
    ];
  }
}
