import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import type { UserWithBranch } from '../../../common/utils/branch-scope.util';
import {
  assertResourceBranch,
  effectiveBranchIdForQuery,
  requireUserBranchId,
} from '../../../common/utils/branch-scope.util';
import { adjustDailyBalance } from '../../../common/utils/daily-balance.util';
import { computeBranchDaySnapshot } from '../../../common/utils/daily-balance-aggregate.util';
import { Role } from '../../../common/enums';
import { NotificationsService } from '../../notifications/services/notifications.service';
import { normalizeCustomerFullName } from '../../../common/utils/customer-name.util';

type CustomerGroupMatch = {
  id: string;
  full_name: string;
  branch_id: string | null;
};

type CustomerTimelineScope = {
  customer: CustomerGroupMatch;
  matchingCustomerIds: string[];
  matchingPawnedItemIds: string[];
};

type LayawayInput = {
  customer?: {
    firstName?: string;
    middleName?: string;
    lastName?: string;
    contactNo?: string;
    address?: string;
  };
  terms?: string;
  itemPrice?: number;
  downpayment?: number;
  remainingBalance?: number;
  processedByName?: string;
};

@Injectable()
export class TransactionsService {
  constructor(
    private supabase: SupabaseService,
    private notificationsService: NotificationsService,
  ) {}

  private async resolveCustomerTimelineScope(
    user: UserWithBranch,
    customerId: string,
  ): Promise<CustomerTimelineScope | null> {
    const client = this.supabase.getClient();
    let customerQuery = client
      .from('customers')
      .select('id, full_name, branch_id')
      .eq('id', customerId);

    if (user.role !== Role.SUPER_ADMIN) {
      customerQuery = customerQuery.eq('branch_id', requireUserBranchId(user));
    }

    const { data: customer, error: customerError } = await customerQuery.maybeSingle();

    if (customerError) {
      throw new InternalServerErrorException(customerError.message);
    }

    if (!customer) {
      return null;
    }

    let groupQuery = client.from('customers').select('id, full_name, branch_id');
    if (user.role !== Role.SUPER_ADMIN) {
      groupQuery = groupQuery.eq('branch_id', requireUserBranchId(user));
    }

    const { data: candidates, error: candidatesError } = await groupQuery;
    if (candidatesError) {
      throw new InternalServerErrorException(candidatesError.message);
    }

    const targetName = normalizeCustomerFullName(customer.full_name);
    const matchingCustomerIds = (candidates || [])
      .filter((candidate: CustomerGroupMatch) =>
        normalizeCustomerFullName(candidate.full_name) === targetName,
      )
      .map((candidate: CustomerGroupMatch) => candidate.id);

    if (!matchingCustomerIds.includes(customer.id)) {
      matchingCustomerIds.unshift(customer.id);
    }

    const { data: pawnedItems, error: pawnedItemsError } = await client
      .from('pawned_items')
      .select('id, customer_id')
      .in('customer_id', matchingCustomerIds);

    if (pawnedItemsError) {
      throw new InternalServerErrorException(pawnedItemsError.message);
    }

    return {
      customer,
      matchingCustomerIds,
      matchingPawnedItemIds: (pawnedItems || []).map((item: { id: string }) => item.id),
    };
  }

  async create(user: UserWithBranch, dto: any) {
    // Drop client-only fields that are not real DB columns.
    // This prevents 500s when UI sends extra metadata.
    const { layaway: layawayInput, ...dtoClean } = dto ?? {};
    const isLayaway = !!layawayInput;

    // 1. Resolve Branch Info
    const branchId =
      dtoClean.branch_id ||
      (user.role !== Role.SUPER_ADMIN ? requireUserBranchId(user) : null);
    
    // Allow branchless transactions only for Super Admin creating system-wide expenses
    const isSystemExpense =
      !branchId &&
      user.role === Role.SUPER_ADMIN &&
      dtoClean.purpose === 'Expense';

    if (!branchId && !isSystemExpense) {
      throw new InternalServerErrorException(
        'Missing branch_id for transaction.',
      );
    }

    const branchName = isSystemExpense
      ? 'System / Head Office'
      : (dtoClean.branch || 'Unknown Branch');

    // Generate transaction number if not provided
    const transactionNo =
      dtoClean.transaction_no ||
      `${dtoClean.purpose?.substring(0, 2).toUpperCase() || 'TX'}-${Date.now()}`;

    const payload = {
      ...dtoClean,
      transaction_no: transactionNo,
      branch_id: branchId || null,
      branch: branchName,
      transaction_date:
        dtoClean.transaction_date || new Date().toISOString().split('T')[0],
      transaction_time:
        dtoClean.transaction_time || new Date().toTimeString().slice(0, 8),
      created_by_user_id: dtoClean.created_by_user_id || user?.id,
      return_amount: dtoClean.return_amount ?? 0,
      storage_fee: dtoClean.storage_fee ?? 0,
      pawn_amount: dtoClean.pawn_amount ?? 0,
      cash_in: dtoClean.cash_in ?? 0,
      cash_out: dtoClean.cash_out ?? 0,
    };

    const { cash_in, cash_out } = payload;
    const client = this.supabase.getClient();
    let layawayCustomer:
      | {
          firstName: string;
          middleName: string | null;
          lastName: string;
          contactNo: string;
          address: string;
          fullName: string;
        }
      | null = null;

    if (isLayaway) {
      const customer = layawayInput.customer || {};
      const firstName = customer.firstName?.trim();
      const lastName = customer.lastName?.trim();
      const middleName = customer.middleName?.trim() || null;
      const contactNo = customer.contactNo?.trim();
      const address = customer.address?.trim();

      if (!firstName || !lastName || !contactNo || !address) {
        throw new BadRequestException('Customer information is required for Reserve / Layaway.');
      }

      layawayCustomer = {
        firstName,
        middleName,
        lastName,
        contactNo,
        address,
        fullName: [firstName, middleName, lastName].filter(Boolean).join(' '),
      };

      const { data: activeReservation, error: activeReservationError } = await client
        .from('layaway_reservations')
        .select('id, status, related_sale_item_id')
        .eq('related_sale_item_id', dto.related_sale_item_id)
        .in('status', ['RESERVED', 'PARTIALLY_PAID'])
        .maybeSingle();

      if (activeReservationError) {
        throw new InternalServerErrorException(activeReservationError.message);
      }

      if (activeReservation) {
        throw new ConflictException(
          'This item already has an active reserve/layaway record.',
        );
      }
    }

    // 1. Insert Transaction
    const { data, error } = await client
      .from('transactions')
      .insert([payload])
      .select()
      .single();

    if (error) {
      console.error('[Transactions DB Error]', error);
      throw new InternalServerErrorException(error.message);
    }

    if (isLayaway) {
      const { data: saleItem, error: saleItemError } = await client
        .from('sale_items')
        .select('id, item_id, item_name, price')
        .eq('id', dto.related_sale_item_id)
        .maybeSingle();

      if (saleItemError) {
        throw new InternalServerErrorException(saleItemError.message);
      }
      if (!saleItem) {
        throw new BadRequestException('Selected sale item was not found.');
      }

      const itemPrice = Number(saleItem.price ?? layawayInput.itemPrice ?? 0);
      const downpayment = Number(payload.cash_in || layawayInput.downpayment || 0);
      const remainingBalance = Number(
        Math.max(itemPrice - downpayment, 0).toFixed(2),
      );
      const reservationStatus =
        remainingBalance <= 0
          ? 'COMPLETED'
          : downpayment > 0
            ? 'PARTIALLY_PAID'
            : 'RESERVED';

      const { error: layawayError } = await client
        .from('layaway_reservations')
        .insert([
          {
            transaction_id: data.id,
            related_sale_item_id: dto.related_sale_item_id,
            branch_id: branchId,
            customer_first_name: layawayCustomer?.firstName,
            customer_middle_name: layawayCustomer?.middleName,
            customer_last_name: layawayCustomer?.lastName,
            customer_full_name: layawayCustomer?.fullName,
            customer_contact_number: layawayCustomer?.contactNo,
            customer_address: layawayCustomer?.address,
            item_name: saleItem.item_name ?? payload.unit,
            item_code: saleItem.item_id ?? payload.unit_code,
            item_price: itemPrice,
            downpayment,
            remaining_balance: remainingBalance,
            terms: layawayInput.terms || null,
            status: reservationStatus,
            processed_by_user_id: user.id,
            processed_by_name: layawayInput.processedByName || null,
          },
        ]);

      if (layawayError) {
        console.error('[Layaway DB Error]', layawayError);
        throw new InternalServerErrorException(layawayError.message);
      }

    }

    if (branchId && (cash_in || cash_out)) {
      const netChange = parseFloat(cash_in || 0) - parseFloat(cash_out || 0);
      await adjustDailyBalance(client, branchId, netChange);
    }

    // 3. Create Notification
    try {
      const title =
        dtoClean.purpose === 'Buy Back'
          ? `Successful buyback completed - ${transactionNo}`
          : `New ${dtoClean.purpose?.toLowerCase() || 'transaction'} created - ${transactionNo}`;

      const subtitle = dtoClean.unit
        ? `Transaction Alert: ${dtoClean.purpose?.toLowerCase() || 'item'} [${dtoClean.unit}]`
        : `Transaction Alert: ${dtoClean.purpose?.toLowerCase() || 'activity'}`;

      await this.notificationsService.create({
        title,
        subtitle,
        category: 'Transactions',
        branch_id: branchId,
      });
    } catch (e) {
      console.warn('[TransactionsService] Failed to create notification', e);
    }

    return data;
  }

  async findAll(
    user: UserWithBranch,
    branchQuery?: string,
    date?: string,
    range?: string,
    customerId?: string,
  ) {
    const client = this.supabase.getClient();
    let query = client
      .from('transactions')
      .select(
        `
        *,
        pawned_item:pawned_items (
          *,
          customer:customers (
            full_name,
            address,
            barangay,
            city,
            region,
            contact_number
          )
        ),
        sale_item:sale_items (*)
      `,
      )
      .order('transaction_date', { ascending: false })
      .order('transaction_time', { ascending: false });

    const scoped = effectiveBranchIdForQuery(user, branchQuery);
    if (scoped) {
      query = query.eq('branch_id', scoped);
    }

    const customerScope = customerId
      ? await this.resolveCustomerTimelineScope(user, customerId)
      : null;

    if (customerId && !customerScope) {
      return {
        transactions: [],
        stats: {
          pawnedToday: 0,
          buyBack: 0,
          renewed: 0,
          soldItem: 0,
          redeemed: 0,
          transfer: 0,
          startingBalance: 0,
          endingBalance: 0,
        },
      };
    }

    // Skip date filtering if customerId is provided - show all customer's transactions
    if (!customerId) {
      if (date) {
        query = query.eq('transaction_date', date);
      } else if (range && range !== 'daily') {
        if (range === 'weekly') {
          const lastWeek = new Date();
          lastWeek.setDate(lastWeek.getDate() - 7);
          query = query.gte(
            'transaction_date',
            lastWeek.toISOString().split('T')[0],
          );
        } else if (range === 'monthly') {
          const lastMonth = new Date();
          lastMonth.setMonth(lastMonth.getMonth() - 1);
          query = query.gte(
            'transaction_date',
            lastMonth.toISOString().split('T')[0],
          );
        }
        // If range is 'all', we don't apply any date filter
      } else if (range === 'daily' || !range) {
        // Keep daily default for general transaction list calls (when no customerId).
        const filterDate =
          date ||
          new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
        query = query.eq('transaction_date', filterDate);
      }
    }

    const { data: transactions, error } = await query;
    if (error) throw new InternalServerErrorException(error.message);

    // Filter by customerId after fetching (post-filter)
    let filtered = transactions;
    if (customerScope) {
      const customerIdSet = new Set(customerScope.matchingCustomerIds);
      const pawnedItemIdSet = new Set(customerScope.matchingPawnedItemIds);
      filtered = transactions.filter(
        (tx: any) => {
          const transactionCustomerId =
            tx.customer_id ??
            tx.customerId ??
            tx.pawned_item?.customer_id ??
            tx.pawned_item?.customer?.id ??
            null;

          const relatedPawnedItemId =
            tx.related_pawned_item_id ??
            tx.pawned_item?.id ??
            null;

          return (
            (transactionCustomerId != null && customerIdSet.has(transactionCustomerId)) ||
            (relatedPawnedItemId != null && pawnedItemIdSet.has(relatedPawnedItemId))
          );
        },
      );
    }

    // Compute stats for the requested date and range
    const stats = {
      pawnedToday: filtered.filter((t: any) => t.purpose === 'Pawn').length,
      buyBack: filtered.filter((t: any) => t.purpose === 'Buy Back').length,
      renewed: filtered.filter((t: any) => t.purpose === 'Renew').length,
      soldItem: filtered.filter(
        (t: any) => t.purpose === 'Sold Item' || t.purpose === 'Sale',
      ).length,
      redeemed: filtered.filter((t: any) => t.purpose === 'Redeem').length,
      transfer: filtered.filter(
        (t: any) =>
          t.purpose === 'Fund Transfer' || t.purpose === 'Cash Transfer',
      ).length,
      startingBalance: 0,
      endingBalance: 0,
    };

    // If a specific branch is scoped, compute balance dynamically:
    // End Day = Start Day (employee input) + Σ(cash_in) - Σ(cash_out)
    if (scoped) {
      const balanceDate = date || new Date().toISOString().split('T')[0];

      // 1. Get starting balance from daily_balances or carry-forward
      const { data: balanceData } = await client
        .from('daily_balances')
        .select('starting_balance, ending_balance')
        .eq('branch_id', scoped)
        .eq('record_date', balanceDate)
        .maybeSingle();

      if (balanceData) {
        stats.startingBalance = Number(balanceData.starting_balance || 0);
      } else {
        // Carry forward previous day's ending balance
        const { data: priorRow } = await client
          .from('daily_balances')
          .select('ending_balance')
          .eq('branch_id', scoped)
          .lt('record_date', balanceDate)
          .order('record_date', { ascending: false })
          .limit(1)
          .maybeSingle();
        stats.startingBalance = Number(priorRow?.ending_balance || 0);
      }

      // 2. Always compute ending balance dynamically from ALL today's transactions
      const { data: allTodayTxs } = await client
        .from('transactions')
        .select('purpose, cash_in, cash_out')
        .eq('branch_id', scoped)
        .eq('transaction_date', balanceDate);

      const todayNet = (allTodayTxs ?? []).reduce((sum: number, tx: any) => {
        const p = String(tx.purpose ?? '').toLowerCase().trim();
        if (p === 'start' || p === 'end') return sum;
        return (
          sum +
          (parseFloat(String(tx.cash_in ?? 0)) || 0) -
          (parseFloat(String(tx.cash_out ?? 0)) || 0)
        );
      }, 0);

      stats.endingBalance = Number(
        (stats.startingBalance + todayNet).toFixed(2),
      );
    }

    return { transactions: filtered, stats };
  }

  async findOne(user: UserWithBranch, id: string) {
    const client = this.supabase.getClient();
    const { data, error } = await client
      .from('transactions')
      .select('*')
      .eq('id', id)
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    assertResourceBranch(user, data?.branch_id);
    return data;
  }
}
