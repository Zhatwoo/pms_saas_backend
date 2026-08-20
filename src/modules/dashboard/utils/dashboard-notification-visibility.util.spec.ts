import { Role } from '../../../common/enums';
import {
  buildDashboardNotificationsOrFilter,
  filterDashboardNotificationsForViewer,
  isSuperAdminPlatformNotification,
} from './dashboard-notification-visibility.util';

describe('dashboard notification visibility', () => {
  const newBranchAdded = {
    title: 'New branch added - 123 Branch',
    target_role: Role.SUPER_ADMIN,
    branch_id: null,
    user_id: null,
  };
  const deviceAuthRequest = {
    title: 'Device Authorization Request from Jane',
    target_role: Role.SUPER_ADMIN,
    branch_id: 'branch-a',
    user_id: null,
  };
  const expirationAlert = {
    title: 'Expiration Alert: 001-JCLB-00001',
    target_role: null,
    branch_id: 'branch-a',
    user_id: null,
  };
  const personalAlert = {
    title: 'Password request approved',
    target_role: null,
    branch_id: null,
    user_id: 'employee-1',
  };

  it('treats Super Admin branch-created alerts as platform notifications', () => {
    expect(isSuperAdminPlatformNotification(newBranchAdded)).toBe(true);
  });

  it('keeps same-company branch requests and personal alerts visible', () => {
    expect(isSuperAdminPlatformNotification(deviceAuthRequest)).toBe(false);
    expect(isSuperAdminPlatformNotification(expirationAlert)).toBe(false);
    expect(isSuperAdminPlatformNotification(personalAlert)).toBe(false);
  });

  it('hides Super Admin “New branch added” alerts from employees', () => {
    const visible = filterDashboardNotificationsForViewer(
      [newBranchAdded, deviceAuthRequest, expirationAlert, personalAlert],
      Role.EMPLOYEE,
    );

    expect(visible.map((row) => row.title)).toEqual([
      deviceAuthRequest.title,
      expirationAlert.title,
      personalAlert.title,
    ]);
  });

  it('still shows Super Admin platform alerts to Super Admin', () => {
    const visible = filterDashboardNotificationsForViewer(
      [newBranchAdded, expirationAlert],
      Role.SUPER_ADMIN,
    );

    expect(visible.map((row) => row.title)).toEqual([
      newBranchAdded.title,
      expirationAlert.title,
    ]);
  });

  it('builds an employee query that excludes Super Admin-only globals', () => {
    expect(
      buildDashboardNotificationsOrFilter({
        role: Role.EMPLOYEE,
        userId: 'employee-1',
        branchId: 'branch-a',
      }),
    ).toBe(
      `user_id.eq.employee-1,branch_id.eq.branch-a,and(branch_id.is.null,or(target_role.is.null,target_role.neq.${Role.SUPER_ADMIN}))`,
    );
  });

  it('keeps Super Admin unscoped queries unfiltered', () => {
    expect(
      buildDashboardNotificationsOrFilter({
        role: Role.SUPER_ADMIN,
        userId: 'super-1',
        branchId: null,
      }),
    ).toBeNull();
  });
});
