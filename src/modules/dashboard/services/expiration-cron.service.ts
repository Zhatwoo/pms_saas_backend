import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import { NotificationsService } from '../../notifications/services/notifications.service';

@Injectable()
export class ExpirationCronService {
  private readonly logger = new Logger(ExpirationCronService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly notificationsService: NotificationsService,
  ) {}

  // Run every day at 8:00 AM
  @Cron('0 8 * * *')
  async handleExpirationMonitoring() {
    this.logger.log('Running expiration monitoring cron job...');
    const client = this.supabase.getClient();

    try {
      // Fetch active pawned items
      const { data: items, error } = await client
        .from('pawned_items')
        .select('id, item_id, item_name, branch_id, pawn_date, category')
        .eq('status', 'Active');

      if (error) {
        this.logger.error('Failed to fetch pawned items', error);
        return;
      }

      // Fetch interest rates settings
      const { data: settingsData } = await client
        .from('shop_settings')
        .select('setting_value')
        .eq('setting_key', 'interest_rates')
        .maybeSingle();
      const interestRates = (settingsData?.setting_value as any[]) || [];

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const targetDays = [7, 3, 1, 0];

      let count = 0;
      for (const item of items || []) {
        if (!item.pawn_date) continue;

        const category = item.category;
        const group = interestRates.find((g: any) => g.categories?.includes(category));
        const defaultDuration = group ? (group.defaultDuration ?? 30) : 30;

        const maturityDate = new Date(item.pawn_date);
        maturityDate.setDate(maturityDate.getDate() + defaultDuration);
        maturityDate.setHours(0, 0, 0, 0);

        const diffTime = maturityDate.getTime() - today.getTime();
        const daysRemaining = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        if (targetDays.includes(daysRemaining) || daysRemaining < 0) {
          // If it's negative, we notify as overdue. But to avoid duplicate overdues every single day,
          // we might just log it or notify if it's exactly -1 (1 day overdue)
          if (daysRemaining < 0 && daysRemaining !== -1) {
            continue; // Only notify once when it becomes overdue (-1)
          }

          const isOverdue = daysRemaining < 0;
          const statusText = isOverdue
            ? 'is overdue'
            : daysRemaining === 0
              ? 'expires today'
              : `expires in ${daysRemaining} days`;

          await this.notificationsService.create({
            title: `Expiration Alert: ${item.item_id}`,
            subtitle: `Item ${item.item_name} (Ticket ${item.item_id}) ${statusText}.`,
            category: 'Alerts',
            branch_id: item.branch_id,
          });

          count++;
        }
      }

      this.logger.log(`Generated ${count} expiration notifications.`);
    } catch (e) {
      this.logger.error('Error during expiration monitoring', e);
    }
  }
}
