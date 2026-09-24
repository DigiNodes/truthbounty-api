import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RejectDisputeDto {
  @ApiProperty({ description: 'Reason the dispute was rejected' })
  @IsString()
  @IsNotEmpty()
  reason: string;
}