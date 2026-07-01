import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Role } from '../enums';
import { REQUIRES_OPENING_CHECKLIST_KEY } from '../decorators/requires-opening-checklist.decorator';
import { ALLOW_OPENING_INVENTORY_AUDIT_KEY } from '../decorators/allow-opening-inventory-audit.decorator';
import { OpeningChecklistGateService } from '../../modules/branch-finance/services/opening-checklist-gate.service';

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
    private readonly openingGate: OpeningChecklistGateService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiresChecklist = this.reflector.getAllAndOverride<boolean>(
      REQUIRES_OPENING_CHECKLIST_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiresChecklist) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<OpeningChecklistRequest>();
    const user = request.user;

    if (!user || user.role === Role.SUPER_ADMIN) {
      return true;
    }

    if (!user.branchId) {
      throw new ForbiddenException('Branch opening checklist is required');
    }

    const allowInventoryAudit = this.reflector.getAllAndOverride<boolean>(
      ALLOW_OPENING_INVENTORY_AUDIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (allowInventoryAudit) {
      const auditAllowed = await this.openingGate.isInventoryAuditAllowed(
        user.branchId,
      );
      if (auditAllowed) {
        return true;
      }
    }

    const allowed = await this.openingGate.isModulesAllowed(
      user.branchId,
      user.id ?? null,
    );

    if (allowed) {
      return true;
    }

    throw new ForbiddenException(
      'Complete the branch opening checklist before using this module',
    );
  }
}
