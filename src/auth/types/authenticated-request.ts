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
    typeof principal.address === 'string'
  );
}
