import { AsyncLocalStorage } from 'async_hooks';

export const tenantContext = new AsyncLocalStorage<{ tenantId: string }>();

export function getTenantId(): string | undefined {
  return tenantContext.getStore()?.tenantId;
}
