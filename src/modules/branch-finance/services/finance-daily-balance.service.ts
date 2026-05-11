import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { BranchSessionStatus } from '../constants/branch-session-status';
import { operationalNetFromRows } from '../utils/finance-ledger.util';
import { BranchFinanceSessionGateService } from './branch-finance-session-gate.service';

export type FinanceDailyBalanceTx = Prisma.TransactionClient;
type Tx = FinanceDailyBalanceTx;

/**
 * Single writer for daily_balances: locked reads, Decimal math, branch opening capital fallback.
 * All cash-affecting modules must call applyNetChange (or confirmation helpers) instead of ad hoc Supabase updates.
 * Operational postings require branch_business_sessions.status === OPEN for that Manila date.
 */
@Injectable()
export class FinanceDailyBalanceService {
  private readonly logger = new Logger(FinanceDailyBalanceService.name);

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

  /**
   * Ledger ending after applying net cash delta (cash_in − cash_out) for the Manila business date.
   * Locks daily_balances row when present; uses prior day / session / branch opening fallback when missing.
   */
  private async projectEndingAfterDeltaInTx(
    client: Tx,
    branchId: string,
    businessDateStr: string,
    delta: Prisma.Decimal,
    options?: { bypassOperationalSessionGate?: boolean },
  ): Promise<{
    baseline: Prisma.Decimal;
    next: Prisma.Decimal;
    existingRow: { id: string } | null;
    carriedForCreate: Prisma.Decimal;
  }> {
    if (!options?.bypassOperationalSessionGate) {
      await this.sessionGate.assertOperationalPostingAllowed(
        client,
        branchId,
        businessDateStr,
      );
    }

    const date = this.toRecordDate(businessDateStr);

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
      const baseline = this.dec(current.ending_balance);
      return {
        baseline,
        next: baseline.plus(delta),
        existingRow: { id: current.id },
        carriedForCreate: baseline,
      };
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

    let carried: Prisma.Decimal;
    if (prior) {
      carried = this.dec(prior.ending_balance);
    } else {
      const sessionRow = await client.branch_business_sessions.findUnique({
        where: {
          branch_id_business_date: {
            branch_id: branchId,
            business_date: date,
          },
        },
        select: { status: true, starting_balance: true },
      });
      const sessionStart =
        sessionRow?.status === BranchSessionStatus.OPEN &&
        sessionRow.starting_balance != null
          ? this.dec(sessionRow.starting_balance)
          : null;
      carried = sessionStart ?? this.dec(branch?.opening_cash_balance);
    }

    const baseline = carried;
    return {
      baseline,
      next: baseline.plus(delta),
      existingRow: null,
      carriedForCreate: carried,
    };
  }

  private throwIfNegativeEnding(
    next: Prisma.Decimal,
    ctx: {
      branchId: string;
      businessDateStr: string;
      baselineBeforeDelta: Prisma.Decimal;
      netChangeDecimal: Prisma.Decimal;
      /** When set (e.g. reconciliation), overrides gross delta for `required_amount` in the API payload. */
      requiredAmountOverride?: number;
    },
  ): void {
    if (this.allowNegativeEnding() || !next.lt(0)) {
      return;
    }

    const available_balance = Number(ctx.baselineBeforeDelta.toFixed(2));
    const required_amount =
      ctx.requiredAmountOverride ??
      Number(ctx.netChangeDecimal.abs().toFixed(2));

    this.logger.warn(
      `[BranchCash] INSUFFICIENT_FUNDS branchId=${ctx.branchId} businessDate=${ctx.businessDateStr} available_balance=${available_balance} required_amount=${required_amount} netDelta=${ctx.netChangeDecimal.toString()} projectedEnding=${next.toString()} ts=${new Date().toISOString()}`,
    );

    throw new HttpException(
      {
        error: 'INSUFFICIENT_FUNDS',
        message: 'Branch cash is not enough',
        available_balance,
        required_amount,
        branch_id: ctx.branchId,
        business_date: ctx.businessDateStr,
      },
      HttpStatus.BAD_REQUEST,
    );
  }

  /**
   * Validates that applying netChange would not drive ending balance negative, without writing.
   * Call at the start of a DB transaction before creating dependent rows (e.g. pawn ticket).
   */
  async assertNetChangePermittedInTx(
    client: Tx,
    branchId: string,
    businessDateStr: string,
    netChange: number,
  ): Promise<void> {
    if (!branchId || !Number.isFinite(netChange) || netChange === 0) {
      return;
    }
    const delta = new Prisma.Decimal(netChange.toFixed(2));
    const { baseline, next } = await this.projectEndingAfterDeltaInTx(
      client,
      branchId,
      businessDateStr,
      delta,
    );
    this.throwIfNegativeEnding(next, {
      branchId,
      businessDateStr,
      baselineBeforeDelta: baseline,
      netChangeDecimal: delta,
    });
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
   * Use `bypassOperationalSessionGate` only for controlled flows (e.g. fund transfer confirmation).
   */
  async applyNetChange(
    branchId: string | undefined,
    businessDateStr: string,
    netChange: number,
    tx?: Tx,
    options?: { bypassOperationalSessionGate?: boolean },
  ): Promise<void> {
    if (!branchId || !Number.isFinite(netChange) || netChange === 0) {
      return;
    }
    const delta = new Prisma.Decimal(netChange.toFixed(2));
    const date = this.toRecordDate(businessDateStr);

    const run = async (client: Tx) => {
      const { baseline, next, existingRow, carriedForCreate } =
        await this.projectEndingAfterDeltaInTx(
          client,
          branchId,
          businessDateStr,
          delta,
          options,
        );

      this.throwIfNegativeEnding(next, {
        branchId,
        businessDateStr,
        baselineBeforeDelta: baseline,
        netChangeDecimal: delta,
      });

      if (existingRow) {
        await client.daily_balances.update({
          where: { id: existingRow.id },
          data: { ending_balance: next, updated_at: new Date() },
        });
        return;
      }

      await client.daily_balances.create({
        data: {
          branch_id: branchId,
          record_date: date,
          starting_balance: carriedForCreate,
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

    this.throwIfNegativeEnding(ending, {
      branchId,
      businessDateStr,
      baselineBeforeDelta: starting,
      netChangeDecimal: new Prisma.Decimal(net.toFixed(2)),
      requiredAmountOverride: Number((-ending).toFixed(2)),
    });

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
