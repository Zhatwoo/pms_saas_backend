import { IsOptional, IsUUID } from 'class-validator';

export class MergeDuplicateCustomersDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;
}
