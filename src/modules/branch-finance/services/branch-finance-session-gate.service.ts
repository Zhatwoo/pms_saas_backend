import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * Operational cash postings require an open branch_day_sessions row for the Manila calendar date.
 */
@Injectable()
export class BranchFinanceSessionGateService {
  constructor() {}

  async assertOperationalPostingAllowed(
    tx: Tx,
    branchId: string,
    businessDateStr: string,
  ): Promise<void> {
    const date = new Date(`${businessDateStr}T00:00:00.000Z`);

    await tx.$executeRaw`
      SELECT id FROM branch_day_sessions
      WHERE branch_id = ${branchId}::uuid AND session_date = ${date}::date
      FOR UPDATE
    `;

    const row = await tx.branch_day_sessions.findUnique({
      where: {
        branch_id_session_date: {
          branch_id: branchId,
          session_date: date,
        },
      },
    });

    if (!row) {
      throw new HttpException(
        {
          message:
            'Starting balance is required before posting transactions for this branch today.',
          error: 'REQUIRES_STARTING_BALANCE',
          branch_id: branchId,
          business_date: businessDateStr,
        },
        HttpStatus.FORBIDDEN,
      );
    }

    if (row.is_closed) {
      throw new HttpException(
        {
          message: 'Branch is closed for the day. Please start a new session.',
          error: 'SESSION_CLOSED',
          branch_id: branchId,
          business_date: businessDateStr,
        },
        HttpStatus.FORBIDDEN,
      );
    }
  }
}
