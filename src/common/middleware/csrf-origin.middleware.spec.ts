import { ForbiddenException } from '@nestjs/common';
import { CsrfOriginMiddleware } from './csrf-origin.middleware';

describe('CsrfOriginMiddleware', () => {
  const middleware = new CsrfOriginMiddleware();

  function runPost(path: string, headers: Record<string, string> = {}) {
    const req = {
      method: 'POST',
      path,
      headers,
    } as Parameters<CsrfOriginMiddleware['use']>[0];
    const next = jest.fn();
    const invoke = () => middleware.use(req, {} as never, next);
    return { invoke, next };
  }

  it('allows forgot-password without origin headers', () => {
    const { invoke, next } = runPost('/api/auth/forgot-password');
    expect(invoke).not.toThrow();
    expect(next).toHaveBeenCalled();
  });

  it('allows reset-password without origin headers', () => {
    const { invoke, next } = runPost('/api/auth/reset-password');
    expect(invoke).not.toThrow();
    expect(next).toHaveBeenCalled();
  });

  it('blocks non-public POST routes without origin headers', () => {
    const { invoke } = runPost('/api/auth/verify-password');
    expect(invoke).toThrow(ForbiddenException);
  });
});
