import { ForbiddenException } from '@nestjs/common';
import { Role } from '../enums/role.enum';

/** Matches frontend branch context + legacy labels */
const ALL_BRANCHES_SENTINELS = new Set([
  '',
  '__all__',
  'All Branches',
  'all',
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type UserWithBranch = {
  role: Role;
  branchId: string | null;
};

export function isUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

/** Admin / employee must have a branch to access branch-scoped APIs */
export function requireUserBranchId(user: UserWithBranch): string {
  if (user.role === Role.SUPER_ADMIN) {
    throw new ForbiddenException('Use super-admin branch selector; invalid context');
  }
  if (!user.branchId) {
    throw new ForbiddenException(
      'Your account has no branch assigned. Contact a Super Admin.',
    );
  }
  return user.branchId;
}

/**
 * Super admin: optional `branch` query (UUID or empty / all = no filter).
 * Non–super admin: always their `branchId`; query param is ignored.
 */
export function effectiveBranchIdForQuery(
  user: UserWithBranch,
  branchQuery?: string,
): string | null {
  if (user.role === Role.SUPER_ADMIN) {
    const q = branchQuery?.trim() ?? '';
    if (!q || ALL_BRANCHES_SENTINELS.has(q)) {
      return null;
    }
    if (isUuid(q)) {
      return q;
    }
    return null;
  }
  return requireUserBranchId(user);
}

/**
 * When super admin passes a non-UUID branch filter (e.g. name), use ilike on `branch` column.
 */
export function superAdminBranchNameFilter(
  user: UserWithBranch,
  branchQuery?: string,
): string | null {
  if (user.role !== Role.SUPER_ADMIN) {
    return null;
  }
  const q = branchQuery?.trim() ?? '';
  if (!q || ALL_BRANCHES_SENTINELS.has(q) || isUuid(q)) {
    return null;
  }
  return q;
}

export function assertResourceBranch(
  user: UserWithBranch,
  resourceBranchId: string | null | undefined,
): void {
  if (user.role === Role.SUPER_ADMIN) {
    return;
  }
  const mine = requireUserBranchId(user);
  if (resourceBranchId == null || resourceBranchId === '') {
    throw new ForbiddenException('Resource is not associated with a branch');
  }
  if (String(resourceBranchId) !== String(mine)) {
    throw new ForbiddenException('You cannot access data from another branch');
  }
}

/** Branches CRUD: admin may only read their own branch row */
export function assertBranchRowAccess(
  user: UserWithBranch,
  rowBranchUuid: string,
): void {
  if (user.role === Role.SUPER_ADMIN) {
    return;
  }
  const mine = requireUserBranchId(user);
  if (String(rowBranchUuid) !== String(mine)) {
    throw new ForbiddenException('You cannot access this branch');
  }
}

/** Inventory list: UUID filter, or super-admin name search, or all (super admin). */
export function inventoryBranchFilters(
  user: UserWithBranch,
  branchQuery?: string,
): { branchId: string | null; branchNameIlike: string | null } {
  if (user.role !== Role.SUPER_ADMIN) {
    return { branchId: requireUserBranchId(user), branchNameIlike: null };
  }
  const q = branchQuery?.trim() ?? '';
  if (!q || ALL_BRANCHES_SENTINELS.has(q)) {
    return { branchId: null, branchNameIlike: null };
  }
  if (isUuid(q)) {
    return { branchId: q, branchNameIlike: null };
  }
  return { branchId: null, branchNameIlike: q };
}
