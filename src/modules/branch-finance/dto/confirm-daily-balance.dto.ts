import { Type } from 'class-transformer';
import { IsIn, IsNumber, Max, Min } from 'class-validator';

export class ConfirmDailyBalanceDto {
  @IsIn(['starting', 'ending'])
  type: 'starting' | 'ending';

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000_000)
  amount: number;
}
