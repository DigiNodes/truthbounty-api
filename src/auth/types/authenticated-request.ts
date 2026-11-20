export interface AuthenticatedPrincipal {
  address: string;
  userId?: string | null;
  sub?: string;
  user?: {
    id?: string;
    role?: string;
    [key: string]: any;
  } | null;
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
    (typeof principal.address === 'string' ||
      typeof principal.userId === 'string' ||
      (principal.user !== null && typeof principal.user === 'object'))
  );
}

/**
 * Extract canonical capability subject from AuthenticatedPrincipal following documented precedence:
 *
 * 1. Linked user ID: principal.userId or principal.user?.id (non-empty string).
 * 2. Wallet-only address: principal.address (normalized lowercase 0x... address).
 *
 * Returns undefined if neither is present or if principal is missing/malformed.
 * Never accepts caller-supplied body/query/header parameters.
 */
export function extractCapabilitySubject(
  principal: AuthenticatedPrincipal | undefined | null,
): string | undefined {
  if (!principal || typeof principal !== 'object') {
    return undefined;
  }

  // Precedence 1: Linked user ID
  if (typeof principal.userId === 'string' && principal.userId.trim().length > 0) {
    return principal.userId.trim();
  }
  if (
    principal.user &&
    typeof principal.user.id === 'string' &&
    principal.user.id.trim().length > 0
  ) {
    return principal.user.id.trim();
  }

  // Precedence 2: Wallet-only address (normalized to lowercase)
  if (typeof principal.address === 'string' && principal.address.trim().length > 0) {
    return principal.address.trim().toLowerCase();
  }

  return undefined;
}
