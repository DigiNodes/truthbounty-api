import { ApiProperty } from '@nestjs/swagger';

export class ConfigurationValueResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  key: string;

  @ApiProperty({
    description:
      'Configuration JSON. Values for secret-classified keys and fields are returned as [REDACTED].',
  })
  value: unknown;

  @ApiProperty()
  environment: string;

  @ApiProperty()
  version: number;

  @ApiProperty({ nullable: true })
  createdBy: string | null;

  @ApiProperty({ nullable: true })
  changeReason: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class ConfigurationReadResponseDto {
  @ApiProperty()
  key: string;

  @ApiProperty({
    description:
      'Configuration JSON. Values for secret-classified keys and fields are returned as [REDACTED].',
  })
  value: unknown;
}

export class ConfigurationHistoryResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  key: string;

  @ApiProperty({
    description:
      'Historical configuration JSON. Values are redacted using the same policy as current configuration.',
  })
  value: unknown;

  @ApiProperty()
  version: number;

  @ApiProperty({ nullable: true })
  createdBy?: string;

  @ApiProperty({ nullable: true })
  changeReason?: string;

  @ApiProperty()
  createdAt: Date;
}
