import { Controller, Get, Logger } from '@nestjs/common';
import { Public } from '../../common/decorators';

@Controller('public/plans')
export class PublicPlansController {
  private readonly logger = new Logger(PublicPlansController.name);

  @Public()
  @Get()
  async getPublicPlans() {
    const adminBackendUrl =
      process.env.ADMIN_BACKEND_URL || 'http://127.0.0.1:3001';
    try {
      const res = await fetch(`${adminBackendUrl}/api/public/plans`);
      if (res.ok) {
        return await res.json();
      }
    } catch (error) {
      this.logger.debug(
        `Could not fetch plans from PMS Admin (${adminBackendUrl}): ${error}`,
      );
    }
    return { plans: [] };
  }
}
