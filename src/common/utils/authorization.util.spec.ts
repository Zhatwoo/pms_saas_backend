import { Role } from '../enums';
import { getEnvironment } from './authorization.util';

describe('getEnvironment', () => {
  it.each([
    ['production super admin', Role.SUPER_ADMIN, false, 'production'],
    ['production admin', Role.ADMIN, false, 'production'],
    ['production employee', Role.EMPLOYEE, false, 'production'],
    ['developer super admin', Role.SUPER_ADMIN, true, 'development'],
    ['developer admin', Role.ADMIN, true, 'development'],
    ['developer employee', Role.EMPLOYEE, true, 'development'],
  ] as const)(
    'maps a %s account to %s data',
    (_label, role, isDeveloper, expectedEnvironment) => {
      const user = {
        role,
        isDeveloper,
        email: isDeveloper ? `${role}@dev.com` : `${role}@example.com`,
      };

      expect(getEnvironment(user)).toBe(expectedEnvironment);
    },
  );
});
