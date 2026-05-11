import { Type } from 'class-transformer';
import { IsBoolean, IsNumber, IsOptional, Max, Min } from 'class-validator';

/** Explicit acknowledgement required before closing the branch business day (financial safety). */
export class EndBranchDayDto {
  @IsBoolean()
  confirmed: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000_000)
  /** Physical count shown on closing modal (journal detail); system ending uses ledger reconciliation. */
  physicalEndingAmount?: number;
}
