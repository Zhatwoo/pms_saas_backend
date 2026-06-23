import { Role } from '../../../common/enums';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';
import { PawnTicketsService } from './pawn-tickets.service';

describe('PawnTicketsService environment isolation', () => {
  const findMany = jest.fn().mockResolvedValue([]);
  const service = new PawnTicketsService(
    {} as never,
    { pawned_items: { findMany } } as never,
    {} as never,
    {
      decryptCustomerEmbed: jest.fn((value) => value),
    } as never,
    {} as never,
  );

  const makeSuperAdmin = (
    isDeveloper: boolean,
  ): AuthenticatedUserProfile => ({
    id: isDeveloper ? 'developer-super-admin' : 'production-super-admin',
    authId: isDeveloper ? 'developer-auth' : 'production-auth',
    fullName: 'Super Admin',
    email: isDeveloper ? 'owner@dev.com' : 'owner@example.com',
    role: Role.SUPER_ADMIN,
    branchId: null,
    branchName: null,
    avatarUrl: null,
    notificationSound: null,
    isDeveloper,
  });

  beforeEach(() => {
    findMany.mockClear();
  });

  it('limits a normal super admin to production pawn tickets', async () => {
    await service.findAll(makeSuperAdmin(false), {});

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { environment: 'production' },
      }),
    );
  });

  it('limits a developer super admin to development pawn tickets', async () => {
    await service.findAll(makeSuperAdmin(true), {});

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { environment: 'development' },
      }),
    );
  });
});
