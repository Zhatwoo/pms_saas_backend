import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer from 'nodemailer';
import { SupabaseService } from '../../../infrastructure/supabase/supabase.service';
import type { AuthenticatedUserProfile } from '../../../infrastructure/supabase/supabase.service';

interface EmailBlastPayload {
  category: 'overdue' | 'threeDays' | 'sevenDays' | 'thirtyDays';
  branchId?: string;
}

interface ExpirationItemRow {
  ticket_no: string;
  item_description: string;
  days_remaining: number;
  maturity_date: string;
  total_due: number;
  customers?: Array<{
    id?: string;
    email?: string | null;
    full_name?: string | null;
  }> | null;
  branches?: { id?: string } | { id?: string }[] | null;
}

interface NormalizedExpirationItem {
  ticket_no: string;
  item_description: string;
  days_remaining: number;
  maturity_date: string;
  total_due: number;
  customer_email: string;
  customer_name: string;
}

interface CustomerGroupItem {
  ticketNo: string;
  item: string;
  daysRemaining: number;
  maturityDate: string;
  totalDue: number;
}

interface CustomerGroup {
  email: string;
  customerName: string;
  items: CustomerGroupItem[];
}

@Injectable()
export class EmailService {
  private logger = new Logger('EmailService');
  private resendApiKey: string;
  private readonly RESEND_API_URL = 'https://api.resend.com/emails';
  private readonly VERIFIED_EMAIL =
    process.env.RESEND_VERIFIED_EMAIL ||
    process.env.GMAIL_USER ||
    'inquire.quickpawn.pms@gmail.com';

  constructor(
    private supabase: SupabaseService,
    private configService: ConfigService,
  ) {
    this.resendApiKey = this.configService.get<string>('RESEND_API_KEY') || '';
  }

  /**
   * Sends a single plain email via Resend / Nodemailer. Reuses the same sandbox override
   * as sendExpirationBlast: while RESEND_API_KEY is on a non-verified Resend
   * domain, Resend only accepts sends to VERIFIED_EMAIL, so all mail is
   * redirected there regardless of `to` until the sending domain is verified.
   */
  async sendPlainEmail(
    to: string,
    subject: string,
    html: string,
  ): Promise<{ success: boolean; message: string }> {
    const recipient =
      to?.trim() ||
      this.configService.get<string>('CONTACT_FORM_TO_EMAIL') ||
      this.configService.get<string>('GMAIL_USER') ||
      'inquire.quickpawn.pms@gmail.com';
    const userEmail = (
      this.configService.get<string>('GMAIL_USER') || ''
    ).trim();
    const pass = (
      this.configService.get<string>('GMAIL_APP_PASSWORD') || ''
    ).replace(/\s+/g, '');
    const host =
      this.configService.get<string>('SMTP_HOST') || 'smtp.gmail.com';
    const port = Number(this.configService.get<number>('SMTP_PORT') || 465);
    const secure =
      this.configService.get<string>('SMTP_SECURE') !== 'false';
    const fromName =
      this.configService.get<string>('SMTP_FROM_NAME') || 'QuickPawn PMS';

    try {
      if (!userEmail || !pass) {
        throw new Error('Nodemailer credentials (GMAIL_USER or GMAIL_APP_PASSWORD) not configured');
      }

      const transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: {
          user: userEmail,
          pass,
        },
      });

      await transporter.sendMail({
        from: `"${fromName}" <${userEmail}>`,
        to: recipient,
        subject,
        html,
      });

      this.logger.log(`✓ Email sent successfully via Nodemailer to ${recipient}`);
      return { success: true, message: 'Email sent successfully' };
    } catch (smtpError) {
      const smtpMsg =
        smtpError instanceof Error ? smtpError.message : String(smtpError);
      this.logger.warn(
        `Nodemailer send failed to ${recipient}: ${smtpMsg}. Trying Resend fallback...`,
      );

      if (this.resendApiKey) {
        try {
          const response = await fetch(this.RESEND_API_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.resendApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: `${fromName} <onboarding@resend.dev>`,
              to: recipient,
              subject,
              html,
            }),
          });

          if (response.ok) {
            this.logger.log(`✓ Email sent successfully via Resend to ${recipient}`);
            return { success: true, message: 'Email sent successfully' };
          }
        } catch (resendError) {
          this.logger.error(
            `Resend fallback failed for ${recipient}:`,
            resendError,
          );
        }
      }

      this.logger.error(`Failed to send email to ${recipient}: ${smtpMsg}`);
      return { success: false, message: 'Failed to send email' };
    }
  }

  async sendExpirationBlast(
    user: AuthenticatedUserProfile,
    payload: EmailBlastPayload,
  ): Promise<{
    success: boolean;
    sent: number;
    failed: number;
    message: string;
  }> {
    try {
      if (!this.resendApiKey) {
        return {
          success: false,
          sent: 0,
          failed: 0,
          message: 'Email service not configured (RESEND_API_KEY missing)',
        };
      }

      // Get expiration items based on category
      const items = await this.getExpirationItems(payload);
      if (items.length === 0) {
        return {
          success: true,
          sent: 0,
          failed: 0,
          message: 'No customers to notify for this category',
        };
      }

      // Group by unique customer email
      const uniqueCustomers: CustomerGroup[] = Array.from(
        new Map(
          items.map((item) => [
            item.customer_email,
            {
              email: item.customer_email,
              customerName: item.customer_name,
              items: [] as CustomerGroup['items'],
            },
          ]),
        ).values(),
      );

      // Add items to each customer
      items.forEach((item) => {
        const customer = uniqueCustomers.find(
          (c) => c.email === item.customer_email,
        );
        if (customer) {
          customer.items.push({
            ticketNo: item.ticket_no,
            item: item.item_description,
            daysRemaining: item.days_remaining,
            maturityDate: item.maturity_date,
            totalDue: item.total_due,
          });
        }
      });

      // Send emails
      let sentCount = 0;
      let failedCount = 0;

      for (const customer of uniqueCustomers) {
        try {
          const emailSent = await this.sendExpirationEmail(
            customer,
            payload.category,
          );
          if (emailSent) {
            sentCount++;
          } else {
            failedCount++;
          }
        } catch (error) {
          this.logger.error(
            `Failed to send email to ${customer.email}`,
            error instanceof Error ? error.message : 'Unknown error',
          );
          failedCount++;
        }
      }

      return {
        success: true,
        sent: sentCount,
        failed: failedCount,
        message: `Email blast sent to ${sentCount} customer${sentCount !== 1 ? 's' : ''}${failedCount > 0 ? `. ${failedCount} failed` : ''}`,
      };
    } catch (error) {
      this.logger.error(
        'Email blast error:',
        error instanceof Error ? error.message : 'Unknown error',
      );
      return {
        success: false,
        sent: 0,
        failed: 0,
        message: 'Failed to send email blast',
      };
    }
  }

  private async getExpirationItems(
    payload: EmailBlastPayload,
  ): Promise<NormalizedExpirationItem[]> {
    const client = this.supabase.getClient();

    let query = client
      .from('pawned_items')
      .select(
        `
        id,
        ticket_no,
        item_description,
        days_remaining,
        maturity_date,
        total_due,
        customers (
          id,
          email,
          full_name
        ),
        branches (
          id
        )
      `,
      )
      .is('is_sold', false)
      .is('is_expired', false);

    // Filter by days remaining based on category
    switch (payload.category) {
      case 'overdue':
        query = query.lte('days_remaining', 0);
        break;
      case 'threeDays':
        query = query.gte('days_remaining', 0).lte('days_remaining', 3);
        break;
      case 'sevenDays':
        query = query.gte('days_remaining', 0).lte('days_remaining', 7);
        break;
      case 'thirtyDays':
        query = query.gte('days_remaining', 0).lte('days_remaining', 30);
        break;
    }

    // Filter by branch if not super admin
    if (payload.branchId) {
      query = query.eq('branches.id', payload.branchId);
    }

    const { data, error } = await query;

    if (error) {
      this.logger.error('Failed to fetch expiration items', error.message);
      return [];
    }

    const rows = (data ?? []) as ExpirationItemRow[];

    return rows.map((item) => {
      const customer = Array.isArray(item.customers)
        ? item.customers[0]
        : undefined;
      return {
        ticket_no: item.ticket_no,
        item_description: item.item_description,
        days_remaining: item.days_remaining,
        maturity_date: item.maturity_date,
        total_due: item.total_due,
        customer_email: customer?.email || '',
        customer_name: customer?.full_name || 'Valued Customer',
      };
    });
  }

  private async sendExpirationEmail(
    customer: CustomerGroup,
    category: string,
  ): Promise<boolean> {
    try {
      const categoryLabels: Record<string, string> = {
        overdue: 'Overdue Items',
        threeDays: 'Expiring in 3 Days',
        sevenDays: 'Expiring in 7 Days',
        thirtyDays: 'Expiring Soon',
      };

      const html = this.generateEmailHtml(
        customer.customerName,
        customer.items,
        categoryLabels[category] || category,
      );

      // In development/testing, send to verified email
      const toEmail = this.VERIFIED_EMAIL;
      const testNotice =
        customer.email !== toEmail
          ? `\n[TEST MODE] Sending to verified email. Actual recipient: ${customer.email}`
          : '';

      const response = await fetch(this.RESEND_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: 'QuickPawn Pawnshop <onboarding@resend.dev>',
          to: toEmail,
          subject: `[TEST] ${categoryLabels[category]} - ${customer.customerName} (${customer.email})`,
          html,
        }),
      });

      if (!response.ok) {
        const error: unknown = await response.json();
        this.logger.error(`Resend API error for ${toEmail}:`, error);
        return false;
      }

      this.logger.log(`✓ Email sent to ${toEmail}${testNotice}`);
      return true;
    } catch (error) {
      this.logger.error(
        `Email sending error for ${customer.email}:`,
        error instanceof Error ? error.message : 'Unknown error',
      );
      return false;
    }
  }

  private generateEmailHtml(
    customerName: string,
    items: CustomerGroupItem[],
    category: string,
  ): string {
    const itemsList = items
      .map(
        (item) => `
      <tr>
        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">
          <strong>${item.ticketNo}</strong>
        </td>
        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">
          ${item.item}
        </td>
        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb;">
          ${item.daysRemaining > 0 ? item.daysRemaining + ' days' : 'OVERDUE'}
        </td>
        <td style="padding: 12px; border-bottom: 1px solid #e5e7eb; text-align: right;">
          ₱${item.totalDue.toLocaleString('en-PH', { maximumFractionDigits: 2 })}
        </td>
      </tr>
    `,
      )
      .join('');

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: white; padding: 20px; border-radius: 8px 8px 0 0; }
            .content { background: #f9fafb; padding: 20px; border-radius: 0 0 8px 8px; }
            .warning { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 12px; margin: 15px 0; border-radius: 4px; }
            table { width: 100%; border-collapse: collapse; margin: 15px 0; }
            .button { display: inline-block; background: #10b981; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 15px; }
            .footer { text-align: center; font-size: 12px; color: #6b7280; margin-top: 20px; padding-top: 20px; border-top: 1px solid #e5e7eb; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <h1 style="margin: 0;">QuickPawn Pawnshop</h1>
              <p style="margin: 5px 0 0 0;">Pawnshop Management System</p>
            </div>
            
            <div class="content">
              <p>Dear ${customerName},</p>
              
              <div class="warning">
                <strong>⚠️ Action Required</strong>
                <p style="margin: 5px 0 0 0;">You have items ${category.toLowerCase()}. Please review and take action accordingly.</p>
              </div>

              <p><strong>Items Summary:</strong></p>
              <table>
                <thead>
                  <tr style="background: #e5e7eb;">
                    <th style="padding: 12px; text-align: left;">Ticket #</th>
                    <th style="padding: 12px; text-align: left;">Item</th>
                    <th style="padding: 12px; text-align: left;">Days Left</th>
                    <th style="padding: 12px; text-align: right;">Amount Due</th>
                  </tr>
                </thead>
                <tbody>
                  ${itemsList}
                </tbody>
              </table>

              <p><strong>What you can do:</strong></p>
              <ul>
                <li>Renew your items to extend the expiration date</li>
                <li>Redeem your items to take them back</li>
                <li>Contact us if you need assistance</li>
              </ul>

              <center>
                <a href="https://quickpawn.ph/pawn-ticket" class="button">View Your Items</a>
              </center>

              <p style="margin-top: 30px; font-size: 14px; color: #6b7280;">
                Best regards,<br>
                <strong>QuickPawn Pawnshop Management Team</strong>
              </p>
            </div>

            <div class="footer">
              <p>This is an automated message. Please do not reply to this email.</p>
              <p>&copy; 2026 QuickPawn Pawnshop. All rights reserved.</p>
            </div>
          </div>
        </body>
      </html>
    `;
  }
}
