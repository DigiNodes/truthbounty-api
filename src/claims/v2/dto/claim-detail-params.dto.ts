import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export class ClaimDetailParamsDto {
  @ApiProperty({
    description: 'UUID of the claim to retrieve',
    example: '00000000-0000-0000-0000-000000000000',
  })
  @IsString()
  @IsNotEmpty()
  id: string;
}
