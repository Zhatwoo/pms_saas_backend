import { Injectable } from '@nestjs/common';
import { Role } from '../../../common/enums';

@Injectable()
export class DashboardService {
  getDashboard(user: { role: Role }) {
    switch (user?.role) {
      case Role.SUPERADMIN:
        return { view: 'superadmin', data: 'All branches, all users, system stats' };
      case Role.ADMIN:
        return { view: 'admin', data: 'Assigned branches, staff, transactions' };
      case Role.BRANCH:
        return { view: 'branch', data: 'Own branch transactions and items' };
      default:
        return { view: 'guest', data: null };
    }
  }
}
