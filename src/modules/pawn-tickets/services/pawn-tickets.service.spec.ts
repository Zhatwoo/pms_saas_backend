import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { PawnTicketsService } from './pawn-tickets.service';

describe('PawnTicketsService.findByUnitCode', () => {
  const pawnedItemsFindFirst = jest.fn<() => Promise<Record<string, unknown> | null>>();
  const saleItemsFindFirst = jest.fn<() => Promise<Record<string, unknown> | null>>();
  const prisma = {
    pawned_items: { findFirst: pawnedItemsFindFirst },
    sale_items: { findFirst: saleItemsFindFirst },
  };
  const encryption = {
    decryptCustomerEmbed: jest.fn((value: unknown) => value),
  };
  const supabase = {
    getClient: jest.fn(),
  };

  let service: PawnTicketsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PawnTicketsService(
      supabase as never,
      prisma as never,
      {} as never,
      encryption as never,
      {} as never,
    );
  });

  it('returns sale listing content when the unit code is a sale item', async () => {
    pawnedItemsFindFirst.mockResolvedValue(null);
    saleItemsFindFirst.mockResolvedValue({
      id: 'sale-uuid',
      item_id: 'SALE-123456',
      item_name: 'Gold Ring',
      category: 'Jewelry',
      price: 2500,
      available_date: new Date('2026-08-18T00:00:00.000Z'),
      status: 'Available',
      image_url: null,
      customers: null,
      branches: {
        name: 'BGC Branch',
        location: 'Taguig',
        phone: '02-123',
      },
      pawned_items: null,
    });

    const result = await service.findByUnitCode('SALE-123456');

    expect(result).toEqual(
      expect.objectContaining({
        listing_type: 'sale',
        item_id: 'SALE-123456',
        item_name: 'Gold Ring',
        amount: 2500,
        status: 'Available',
      }),
    );
  });

  it('still resolves pawn tickets without querying sale items', async () => {
    pawnedItemsFindFirst.mockResolvedValue({
      id: 'pawn-uuid',
      item_id: 'PN-001',
      item_name: 'Laptop',
      amount: 8000,
      pawn_date: new Date('2026-08-01T00:00:00.000Z'),
      profile_photo: null,
      item_photos: [],
      id_photo: null,
      id_back_photo: null,
      customers: null,
      branches: { name: 'BGC Branch' },
    });

    const result = await service.findByUnitCode('PN-001');

    expect(saleItemsFindFirst).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        listing_type: 'pawn',
        item_id: 'PN-001',
      }),
    );
  });

  it('throws when neither a pawn ticket nor a sale item exists', async () => {
    pawnedItemsFindFirst.mockResolvedValue(null);
    saleItemsFindFirst.mockResolvedValue(null);

    await expect(service.findByUnitCode('SALE-MISSING')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
