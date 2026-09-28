export enum PublicErrorCode {
  INTERNAL_SERVER_ERROR = 'INTERNAL_SERVER_ERROR',
  BAD_REQUEST = 'BAD_REQUEST',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  CONFLICT = 'CONFLICT',
  RATE_LIMITED = 'RATE_LIMITED',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  DATABASE_ERROR = 'DATABASE_ERROR',
  AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
}

export const ERROR_CODE_DESCRIPTIONS: Record<PublicErrorCode, string> = {
  [PublicErrorCode.INTERNAL_SERVER_ERROR]: 'An unexpected internal error occurred.',
  [PublicErrorCode.BAD_REQUEST]: 'The request was malformed or invalid.',
  [PublicErrorCode.UNAUTHORIZED]: 'Authentication is required to access this resource.',
  [PublicErrorCode.FORBIDDEN]: 'You do not have permission to access this resource.',
  [PublicErrorCode.NOT_FOUND]: 'The requested resource was not found.',
  [PublicErrorCode.CONFLICT]: 'The request conflicts with the current state of the resource.',
  [PublicErrorCode.RATE_LIMITED]: 'Too many requests. Please try again later.',
  [PublicErrorCode.SERVICE_UNAVAILABLE]: 'The service is temporarily unavailable.',
  [PublicErrorCode.VALIDATION_ERROR]: 'One or more input fields failed validation.',
  [PublicErrorCode.DATABASE_ERROR]: 'A database operation failed.',
  [PublicErrorCode.AUTHENTICATION_FAILED]: 'The provided credentials are invalid.',
  [PublicErrorCode.SESSION_EXPIRED]: 'Your session has expired. Please log in again.',
};