import {
  canCreatorEditIncidentTicket,
  canEditIncidentTicketContent,
  creatorAttemptedManagementUpdate,
  hasCreatorContentUpdate,
  isIncidentTicketManager,
} from './incident-ticket-permissions.util';
import { Role } from '../../common/enums';

describe('incident ticket permissions', () => {
  it('identifies manager roles', () => {
    expect(isIncidentTicketManager(Role.SUPER_ADMIN)).toBe(true);
    expect(isIncidentTicketManager(Role.ADMIN)).toBe(true);
    expect(isIncidentTicketManager(Role.EMPLOYEE)).toBe(false);
  });

  it('allows creators to edit their own unresolved tickets', () => {
    expect(
      canCreatorEditIncidentTicket(
        { reported_by_user_id: 'user-1', status: 'open' },
        'user-1',
      ),
    ).toBe(true);
    expect(
      canCreatorEditIncidentTicket(
        { reported_by_user_id: 'user-1', status: 'resolved' },
        'user-1',
      ),
    ).toBe(false);
    expect(
      canCreatorEditIncidentTicket(
        { reported_by_user_id: 'user-2', status: 'open' },
        'user-1',
      ),
    ).toBe(false);
  });

  it('allows creators or assignees to edit unresolved ticket content', () => {
    expect(
      canEditIncidentTicketContent(
        {
          reported_by_user_id: 'user-1',
          escalation_owner_user_id: 'manager-1',
          status: 'escalated',
        },
        'user-1',
      ),
    ).toBe(true);
    expect(
      canEditIncidentTicketContent(
        {
          reported_by_user_id: 'user-1',
          escalation_owner_user_id: 'manager-1',
          status: 'escalated',
        },
        'manager-1',
      ),
    ).toBe(true);
    expect(
      canEditIncidentTicketContent(
        {
          reported_by_user_id: 'user-1',
          escalation_owner_user_id: 'manager-1',
          status: 'escalated',
        },
        'user-2',
      ),
    ).toBe(false);
    expect(
      canEditIncidentTicketContent(
        {
          reported_by_user_id: 'user-1',
          escalation_owner_user_id: 'manager-1',
          status: 'resolved',
        },
        'manager-1',
      ),
    ).toBe(false);
  });

  it('detects management-only update attempts', () => {
    expect(creatorAttemptedManagementUpdate({ status: 'escalated' })).toBe(true);
    expect(
      creatorAttemptedManagementUpdate({
        title: 'Updated title',
      }),
    ).toBe(false);
  });

  it('detects content update payloads', () => {
    expect(hasCreatorContentUpdate({ summary: 'Updated summary' })).toBe(true);
    expect(hasCreatorContentUpdate({ status: 'open' })).toBe(false);
  });
});
