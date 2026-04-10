import { Injectable } from '@nestjs/common';
import { Role } from '../../../common/enums';

@Injectable()
export class DashboardService {
  getDashboard(user: { role: Role }) {
    switch (user?.role) {
      case Role.SUPER_ADMIN:
        return { view: 'super_admin', data: 'All branches, all users, system stats' };
      case Role.ADMIN:
        return { view: 'admin', data: 'Assigned branches, staff, transactions' };
      case Role.EMPLOYEE:
        return { view: 'employee', data: 'Own branch transactions and items' };
      default:
        return { view: 'guest', data: null };
    }
  }
}
