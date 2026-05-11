import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { operationalNetFromRows } from '../utils/finance-ledger.util';
import { BranchFinanceSessionGateService } from './branch-finance-session-gate.service';

type Tx = Prisma.TransactionClient;

/**
 * Single writer for daily_balances: locked reads, Decimal math, branch opening capital fallback.
 * All cash-affecting modules must call applyNetChange (or confirmation helpers) instead of ad hoc Supabase updates.
 * Operational postings require branch_business_sessions.status === OPEN for that Manila date.
 */
@Injectable()
export class FinanceDailyBalanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly sessionGate: BranchFinanceSessionGateService,
  ) {}

  private toRecordDate(dateStr: string): Date {
    return new Date(`${dateStr}T00:00:00.000Z`);
  }

  private dec(n: unknown): Prisma.Decimal {
    return new Prisma.Decimal(String(n ?? 0));
  }

  private allowNegativeEnding(): boolean {
    return (
      this.config.get<boolean>('security.allowNegativeBranchCashBalance') ?? false
    );
  }

  private assertEndingOk(next: Prisma.Decimal): void {
    if (!this.allowNegativeEnding() && next.lt(0)) {
      throw new BadRequestException('Insufficient branch cash balance');
    }
  }

  /** Operational cash movement for a Manila business date (excludes Start/End markers and voided rows). */
  async sumOperationalNetCash(
    branchId: string,
    businessDateStr: string,
  ): Promise<number> {
    const date = this.toRecordDate(businessDateStr);
    const rows = await this.prisma.transactions.findMany({
      where: { branch_id: branchId, transaction_date: date, voided_at: null },
      select: { purpose: true, cash_in: true, cash_out: true },
    });
    return Number(operationalNetFromRows(rows).toFixed(2));
  }

  async sumOperationalNetCashInTx(
    client: Tx,
    branchId: string,
    businessDateStr: string,
  ): Promise<number> {
    const date = this.toRecordDate(businessDateStr);
    const rows = await client.transactions.findMany({
      where: { branch_id: branchId, transaction_date: date, voided_at: null },
      select: { purpose: true, cash_in: true, cash_out: true },
    });
    return Number(operationalNetFromRows(rows).toFixed(2));
  }

  /**
   * Apply cash delta to ending_balance for the branch business day. Creates today's row with carry-forward
   * (prior ending or branches.opening_cash_balance) when missing.
   */
  async applyNetChange(
    branchId: string | undefined,
    businessDateStr: string,
    netChange: number,
    tx?: Tx,
  ): Promise<void> {
    if (!branchId || !Number.isFinite(netChange) || netChange === 0) {
      return;
    }
    const delta = new Prisma.Decimal(netChange.toFixed(2));
    const date = this.toRecordDate(businessDateStr);

    const run = async (client: Tx) => {
      await this.sessionGate.assertOperationalPostingAllowed(
        client,
        branchId,
        businessDateStr,
      );

      await client.$executeRaw`
        SELECT id FROM daily_balances
        WHERE branch_id = ${branchId}::uuid AND record_date = ${date}::date
        FOR UPDATE
      `;

      const current = await client.daily_balances.findUnique({
        where: {
          branch_id_record_date: { branch_id: branchId, record_date: date },
        },
        select: { id: true, ending_balance: true },
      });

      if (current) {
        const next = this.dec(current.ending_balance).plus(delta);
        this.assertEndingOk(next);
        await client.daily_balances.update({
          where: { id: current.id },
          data: { ending_balance: next, updated_at: new Date() },
        });
        return;
      }

      const prior = await client.daily_balances.findFirst({
        where: { branch_id: branchId, record_date: { lt: date } },
        orderBy: { record_date: 'desc' },
        select: { ending_balance: true },
      });
      const branch = await client.branches.findUnique({
        where: { id: branchId },
        select: { opening_cash_balance: true },
      });
      const carried = prior
        ? this.dec(prior.ending_balance)
        : this.dec(branch?.opening_cash_balance);
      const next = carried.plus(delta);
      this.assertEndingOk(next);
      await client.daily_balances.create({
        data: {
          branch_id: branchId,
          record_date: date,
          starting_balance: carried,
          ending_balance: next,
        },
      });
    };

    if (tx) {
      await run(tx);
      return;
    }

    await this.prisma.$transaction(run, {
      maxWait: 10_000,
      timeout: 30_000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  }

  /**
   * Persist starting/ending balances inside an existing transaction (caller holds locks / orchestrates session).
   */
  async persistConfirmationBalancesInTx(
    client: Tx,
    params: {
      branchId: string;
      businessDateStr: string;
      mode: 'starting' | 'ending';
      confirmedAmount: number;
    },
  ): Promise<{ startingBalance: number; endingBalance: number }> {
    const { branchId, businessDateStr, mode, confirmedAmount } = params;
    const date = this.toRecordDate(businessDateStr);
    const net = await this.sumOperationalNetCashInTx(
      client,
      branchId,
      businessDateStr,
    );
    const conf = Number(confirmedAmount.toFixed(2));

    await client.$executeRaw`
      SELECT id FROM daily_balances
      WHERE branch_id = ${branchId}::uuid AND record_date = ${date}::date
      FOR UPDATE
    `;

    const existing = await client.daily_balances.findUnique({
      where: {
        branch_id_record_date: { branch_id: branchId, record_date: date },
      },
    });

    let starting: Prisma.Decimal;
    let ending: Prisma.Decimal;

    if (mode === 'starting') {
      starting = new Prisma.Decimal(conf);
      ending = starting.plus(net);
    } else {
      if (existing) {
        starting = this.dec(existing.starting_balance);
      } else {
        const prior = await client.daily_balances.findFirst({
          where: { branch_id: branchId, record_date: { lt: date } },
          orderBy: { record_date: 'desc' },
          select: { ending_balance: true },
        });
        const branch = await client.branches.findUnique({
          where: { id: branchId },
          select: { opening_cash_balance: true },
        });
        starting = prior
          ? this.dec(prior.ending_balance)
          : this.dec(branch?.opening_cash_balance);
      }
      ending = starting.plus(net);
    }

    this.assertEndingOk(ending);

    if (existing) {
      await client.daily_balances.update({
        where: { id: existing.id },
        data: {
          starting_balance: starting,
          ending_balance: ending,
          updated_at: new Date(),
        },
      });
    } else {
      await client.daily_balances.create({
        data: {
          branch_id: branchId,
          record_date: date,
          starting_balance: starting,
          ending_balance: ending,
        },
      });
    }

    return {
      startingBalance: Number(starting.toFixed(2)),
      endingBalance: Number(ending.toFixed(2)),
    };
  }

  /**
   * Persist starting/ending after employee confirms opening or closing count.
   * Starting: stored start = confirmed physical count; end = start + same-day operational net (already-posted txs).
   * Ending: recompute end = stored start + same-day operational net (reconciliation).
   */
  async persistConfirmationBalances(params: {
    branchId: string;
    businessDateStr: string;
    mode: 'starting' | 'ending';
    confirmedAmount: number;
  }): Promise<{ startingBalance: number; endingBalance: number }> {
    return this.prisma.$transaction(async (client) =>
      this.persistConfirmationBalancesInTx(client, params),
    );
  }
}
