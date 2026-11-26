export interface AuthenticatedPrincipal {
  address: string;
  userId?: string;
  sub?: string;
  user?: {
    role?: string;
    [key: string]: any;
  };
  [key: string]: any;
}

export interface AuthenticatedRequest {
  user: AuthenticatedPrincipal;
  use?: AuthenticatedPrincipal;
  [key: string]: any;
}

export function isAuthenticatedRequest(req: any): req is AuthenticatedRequest {
  if (!req || typeof req !== 'object') {
    return false;
  }
  const principal = req.user || req.use;
  return (
    principal !== null &&
    typeof principal === 'object' &&
    typeof principal.address === 'string' &&
    principal.address.trim().length > 0
  );
}

/**
 * Returns the verified principal wallet address from an authenticated request,
 * normalized to lowercase. Returns null when no verified principal is present.
 * Callers must derive identity exclusively from this value, never from request
 * body, query, or headers.
 */
export function getVerifiedPrincipalAddress(req: any): string | null {
  if (!isAuthenticatedRequest(req)) {
    return null;
  }
  const principal = req.user || req.use;
  return principal.address.trim().toLowerCase();
}
