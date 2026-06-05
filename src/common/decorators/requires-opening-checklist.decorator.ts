import { SetMetadata } from '@nestjs/common';

export const REQUIRES_OPENING_CHECKLIST_KEY = 'requiresOpeningChecklist';
export const RequiresOpeningChecklist = () =>
  SetMetadata(REQUIRES_OPENING_CHECKLIST_KEY, true);
