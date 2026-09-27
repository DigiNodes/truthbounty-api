import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class RejectDisputeDto {
  @ApiProperty({ description: 'Reason the dispute was rejected' })
  @IsString()
  @IsNotEmpty()
  reason: string;

  @ApiProperty({ description: 'ID of the user rejecting the dispute', required: false })
  @IsString()
  @IsOptional()
  rejectedBy?: string;
}