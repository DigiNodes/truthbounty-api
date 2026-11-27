import { ApiProperty } from '@nestjs/swagger';
import { FeatureFlagType } from '../entities/feature-flag.entity';

/**
 * Public representation of a feature flag.
 * Excludes internal targeting rules, user IDs, rollout configuration,
 * and operational metadata to prevent disclosure of internal rollout strategies.
 */
export class PublicFeatureFlagDto {
  @ApiProperty({
    description: 'Unique identifier for the feature flag',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  })
  id: string;

  @ApiProperty({
    description: 'Feature flag key identifier',
    example: 'enable-new-ui',
  })
  key: string;

  @ApiProperty({
    description: 'Flag type',
    enum: [
      'boolean',
      'percentage',
      'user',
      'role',
      'environment',
      'time',
      'kill-switch',
    ],
    example: 'boolean',
  })
  type: FeatureFlagType;

  @ApiProperty({
    description: 'Whether the flag is currently enabled',
    example: true,
  })
  enabled: boolean;

  @ApiProperty({
    description: 'Environment this flag applies to',
    example: 'production',
  })
  environment: string;

  @ApiProperty({
    description: 'Public description of the feature',
    example: 'Enables the redesigned user interface',
    required: false,
  })
  description?: string;

  @ApiProperty({
    description: 'Flag expiration timestamp',
    required: false,
    example: '2026-12-31T23:59:59Z',
  })
  expiresAt?: Date;

  @ApiProperty({
    description: 'Flag creation timestamp',
    example: '2026-01-01T00:00:00Z',
  })
  createdAt: Date;

  static fromEntity(flag: any): PublicFeatureFlagDto {
    const dto = new PublicFeatureFlagDto();
    dto.id = flag.id;
    dto.key = flag.key;
    dto.type = flag.type;
    dto.enabled = flag.enabled;
    dto.environment = flag.environment;
    dto.description = flag.description;
    dto.expiresAt = flag.expiresAt;
    dto.createdAt = flag.createdAt;
    return dto;
  }
}
