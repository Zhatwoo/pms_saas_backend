import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateRewardDto } from './create-reward.dto';
import { UpdateRewardDto } from './update-reward.dto';

describe('Reward DTO validation', () => {
  it('accepts promo duration fields on create payloads', async () => {
    const dto = plainToInstance(CreateRewardDto, {
      name: 'Summer Cashback',
      reward_value: 1000,
      required_transaction_count: 5,
      promo_start_at: '2026-08-19',
      promo_end_at: '2026-08-27',
    });

    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    expect(errors).toEqual([]);
    expect(dto.promo_start_at).toBe('2026-08-19');
    expect(dto.promo_end_at).toBe('2026-08-27');
  });

  it('accepts promo duration fields on update payloads', async () => {
    const dto = plainToInstance(UpdateRewardDto, {
      name: 'Updated Rule',
      promo_start_at: '2026-08-19',
      promo_end_at: '2026-08-27',
    });

    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    expect(errors).toEqual([]);
  });

  it('rejects unknown properties on update payloads', async () => {
    const dto = plainToInstance(UpdateRewardDto, {
      promo_start_at: '2026-08-19',
      promo_end_at: '2026-08-27',
      unexpected_field: true,
    });

    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    expect(errors.some((error) => error.property === 'unexpected_field')).toBe(true);
  });
});
