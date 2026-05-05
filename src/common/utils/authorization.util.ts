import { ForbiddenException } from '@nestjs/common';
import { Role } from '../enums';

export type AuthorizedUser = {
  id?: string | null;
  authId?: string | null;
  email?: string | null;
  role: Role;
  branchId: string | null;
};

type BranchField = 'branch_id' | 'branchId';

export function isSuperAdmin(user: AuthorizedUser): boolean {
  return user.role === Role.SUPER_ADMIN;
}

export function checkRole(user: AuthorizedUser, allowedRoles: Role[]): void {
  if (!allowedRoles.includes(user.role)) {
    throw new ForbiddenException('You are not allowed to perform this action');
  }
}

export function requireBranchId(user: AuthorizedUser): string {
  if (isSuperAdmin(user)) {
    throw new ForbiddenException('Super Admin must choose an explicit branch');
  }
  if (!user.branchId) {
    throw new ForbiddenException(
      'Your account has no branch assigned. Contact a Super Admin.',
    );
  }
  return user.branchId;
}

/**
 * Central branch guard for Prisma `where` clauses.
 * Non-super-admin users are always scoped to `req.user.branchId`; services must
 * never trust branch IDs supplied by the client for RBAC decisions.
 */
export function buildBranchFilter(
  user: AuthorizedUser,
  field: BranchField = 'branch_id',
): Record<string, string> {
  if (isSuperAdmin(user)) {
    return {};
  }
  return { [field]: requireBranchId(user) };
}

export function assertBranchAccess(
  user: AuthorizedUser,
  resourceBranchId: string | null | undefined,
): void {
  if (isSuperAdmin(user)) {
    return;
  }
  if (!resourceBranchId || resourceBranchId !== requireBranchId(user)) {
    throw new ForbiddenException('You cannot access data from another branch');
  }
}
