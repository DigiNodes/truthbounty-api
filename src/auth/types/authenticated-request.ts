export interface AuthenticatedPrincipal {
  address: string;
  userId?: string | null;
  sub?: string;
  user?: {
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
