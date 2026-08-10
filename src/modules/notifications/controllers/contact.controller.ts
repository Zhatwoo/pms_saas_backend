import { Controller, Post, Body } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AUTH_STRICT_THROTTLE } from '../../../config/throttle-auth.constants';
import { Public } from '../../../common/decorators';
import { EmailService } from '../services/email.service';
import { ContactDto } from '../dto/contact.dto';

const CONTACT_INBOX =
  process.env.CONTACT_FORM_TO_EMAIL || 'inspirenextglobal.marketing@gmail.com';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

@Controller('contact')
export class ContactController {
  constructor(private readonly emailService: EmailService) {}

  @Public()
  @Throttle(AUTH_STRICT_THROTTLE)
  @Post()
  async submit(@Body() dto: ContactDto) {
    const name = escapeHtml(dto.name || '');
    const email = escapeHtml(dto.email || '');
    const preferredDate = dto.preferredDate ? escapeHtml(dto.preferredDate) : 'Not specified';
    const preferredTime = dto.preferredTime ? escapeHtml(dto.preferredTime) : 'Not specified';
    const meetingPlatform = dto.meetingPlatform ? escapeHtml(dto.meetingPlatform) : 'Not specified';
    const message = dto.message ? escapeHtml(dto.message) : 'None';

    const subject =
      dto.preferredDate || dto.meetingPlatform
        ? `[Demo Booking] QuickPawn Demo Request from ${dto.name}`
        : `QuickPawn inquiry from ${dto.name}`;

    const html = `
      <!DOCTYPE html>
      <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; color: #333; background-color: #f9fafb; padding: 20px;">
          <div style="max-width: 600px; margin: 0 auto; padding: 24px; background-color: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px;">
            <div style="border-bottom: 2px solid #059669; padding-bottom: 12px; margin-bottom: 20px;">
              <h2 style="color: #059669; margin: 0;">QuickPawn Demo & Contact Request</h2>
            </div>
            
            <div style="margin-bottom: 16px; padding: 12px; background-color: #ecfdf5; border-radius: 8px; border: 1px solid #a7f3d0;">
              <h3 style="color: #047857; margin-top: 0; margin-bottom: 8px; font-size: 15px;">Demo Schedule Details</h3>
              <p style="margin: 4px 0;"><strong>Preferred Date:</strong> ${preferredDate}</p>
              <p style="margin: 4px 0;"><strong>Preferred Time:</strong> ${preferredTime}</p>
              <p style="margin: 4px 0;"><strong>Meeting Platform:</strong> ${meetingPlatform}</p>
            </div>

            <div style="margin-bottom: 16px;">
              <h3 style="color: #374151; margin-top: 0; margin-bottom: 8px; font-size: 15px;">Contact Details</h3>
              <p style="margin: 4px 0;"><strong>Name:</strong> ${name}</p>
              <p style="margin: 4px 0;"><strong>Email:</strong> ${email}</p>
            </div>

            <div>
              <h3 style="color: #374151; margin-top: 0; margin-bottom: 8px; font-size: 15px;">Notes / Message</h3>
              <p style="white-space: pre-wrap; background-color: #f3f4f6; padding: 12px; border-radius: 6px; color: #4b5563; margin-top: 0;">${message}</p>
            </div>
          </div>
        </body>
      </html>
    `;

    const result = await this.emailService.sendPlainEmail(
      CONTACT_INBOX,
      subject,
      html,
    );

    return result;
  }
}
