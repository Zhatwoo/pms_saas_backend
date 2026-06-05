import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PrismaService } from '../../infrastructure/prisma';
import { Role } from '../enums';
import { getPhCalendarDateString } from '../utils/branch-calendar-date.util';
import { REQUIRES_OPENING_CHECKLIST_KEY } from '../decorators/requires-opening-checklist.decorator';

type OpeningChecklistRequest = Request & {
  user?: {
    id?: string | null;
    role?: Role | null;
    branchId?: string | null;
  };
};

@Injectable()
export class OpeningChecklistGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiresChecklist = this.reflector.getAllAndOverride<boolean>(
      REQUIRES_OPENING_CHECKLIST_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiresChecklist) {
      return true;
    }

    const request = context.switchToHttp().getRequest<OpeningChecklistRequest>();
    const user = request.user;

    if (!user || user.role === Role.SUPER_ADMIN) {
      return true;
    }

    if (!user.branchId) {
      throw new ForbiddenException('Branch opening checklist is required');
    }

    const openingDate = new Date(`${getPhCalendarDateString()}T00:00:00.000Z`);
    const opening = await this.prisma.daily_opening.findUnique({
      where: {
        branch_id_opening_date: {
          branch_id: user.branchId,
          opening_date: openingDate,
        },
      },
      select: { status: true },
    });

    if (opening?.status === 'completed') {
      return true;
    }

    throw new ForbiddenException(
      'Complete the branch opening checklist before using this module',
    );
  }
}
