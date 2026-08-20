import { Role } from '../../../common/enums';

export type DashboardNotificationVisibilityRow = {
  target_role?: string | null;
  branch_id?: string | null;
  user_id?: string | null;
};

export function isSuperAdminPlatformNotification(
  row: DashboardNotificationVisibilityRow,
): boolean {
  return row.target_role === Role.SUPER_ADMIN && !row.branch_id && !row.user_id;
}

export function filterDashboardNotificationsForViewer<
  T extends DashboardNotificationVisibilityRow,
>(rows: T[], role: Role): T[] {
  if (role === Role.SUPER_ADMIN) {
    return rows;
  }

  return rows.filter((row) => !isSuperAdminPlatformNotification(row));
}

export function buildDashboardNotificationsOrFilter(params: {
  role: Role;
  userId: string;
  branchId?: string | null;
}): string | null {
  if (params.role === Role.SUPER_ADMIN) {
    return params.branchId
      ? `branch_id.eq.${params.branchId},branch_id.is.null`
      : null;
  }

  const clauses = [`user_id.eq.${params.userId}`];
  if (params.branchId) {
    clauses.push(`branch_id.eq.${params.branchId}`);
  }

  clauses.push(
    `and(branch_id.is.null,or(target_role.is.null,target_role.neq.${Role.SUPER_ADMIN}))`,
  );

  return clauses.join(',');
}
