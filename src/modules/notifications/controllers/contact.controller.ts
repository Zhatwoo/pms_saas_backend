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
    const name = escapeHtml(dto.name);
    const email = escapeHtml(dto.email);
    const message = escapeHtml(dto.message);

    const html = `
      <!DOCTYPE html>
      <html>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; color: #333;">
          <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #0B5D3B;">New QuickPawn landing page inquiry</h2>
            <p><strong>Name:</strong> ${name}</p>
            <p><strong>Email:</strong> ${email}</p>
            <p><strong>Message:</strong></p>
            <p style="white-space: pre-wrap;">${message}</p>
          </div>
        </body>
      </html>
    `;

    const result = await this.emailService.sendPlainEmail(
      CONTACT_INBOX,
      `QuickPawn inquiry from ${dto.name}`,
      html,
    );

    return result;
  }
}
