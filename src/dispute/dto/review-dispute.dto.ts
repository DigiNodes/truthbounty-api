import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class ReviewDisputeDto {
  @IsIn(['REVIEWING', 'ACCEPTED_FOR_REVIEW', 'DISMISSED'])
  status: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}
