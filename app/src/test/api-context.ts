import type { APIContext } from 'astro';

/**
 * Build a minimal, correctly-typed APIContext for route-handler tests.
 * Route handlers read `params`, `request`, and occasionally `clientAddress`;
 * the remaining APIContext members are collapsed through a single
 * `as unknown as APIContext` boundary in one audited place.
 */
export function makeApiContext(
  partial: {
    params?: Record<string, string | undefined>;
    request: Request;
    clientAddress?: string;
  },
): APIContext {
  return {
    params: partial.params ?? {},
    request: partial.request,
    ...(partial.clientAddress !== undefined
      ? { clientAddress: partial.clientAddress }
      : {}),
  } as unknown as APIContext;
}
