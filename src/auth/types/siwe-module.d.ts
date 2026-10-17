// src/auth/types/siwe-module.d.ts
/**
 * Canonical type declarations for the reviewed 'siwe' (EIP-4361) package.
 *
 * Restores ambient type declarations for siwe v2.3.2 compatible with TypeScript 6+
 * and ethers v6 compilation gates (PREWAVE-BE-013 / #609).
 */

declare module 'siwe' {
  export interface VerifyParams {
    /** Signature of the message signed by the wallet */
    signature: string;
    /** RFC 3986 URI scheme for the authority requesting signing */
    scheme?: string;
    /** RFC 4501 dns authority requesting signing */
    domain?: string;
    /** Randomized token used to prevent replay attacks (>= 8 alphanumeric characters) */
    nonce?: string;
    /** ISO 8601 datetime string of the current time */
    time?: string;
  }

  export interface VerifyOpts {
    /** Ethers provider for EIP-1271 smart contract wallet verification */
    provider?: unknown;
    /** If the library should suppress promise rejections on validation error */
    suppressExceptions?: boolean;
    /** Custom verification callback */
    verificationFallback?: (
      params: VerifyParams,
      opts: VerifyOpts,
      message: SiweMessage,
      eip1271Promise: Promise<SiweResponse>,
    ) => Promise<SiweResponse>;
  }

  export interface SiweResponse {
    /** Boolean indicating if verification succeeded */
    success: boolean;
    /** Error details if verification failed */
    error?: SiweError;
    /** Parsed message that was verified */
    data: SiweMessage;
  }

  export class SiweError {
    constructor(type: SiweErrorType | string, expected?: string, received?: string);
    type: SiweErrorType | string;
    expected?: string;
    received?: string;
  }

  export enum SiweErrorType {
    EXPIRED_MESSAGE = 'Expired message.',
    INVALID_DOMAIN = 'Invalid domain.',
    SCHEME_MISMATCH = 'Scheme does not match provided scheme for verification.',
    DOMAIN_MISMATCH = 'Domain does not match provided domain for verification.',
    NONCE_MISMATCH = 'Nonce does not match provided nonce for verification.',
    INVALID_ADDRESS = 'Invalid address.',
    INVALID_URI = 'URI does not conform to RFC 3986.',
    INVALID_NONCE = 'Nonce size smaller then 8 characters or is not alphanumeric.',
    NOT_YET_VALID_MESSAGE = 'Message is not valid yet.',
    INVALID_SIGNATURE = 'Signature does not match address of the message.',
    INVALID_TIME_FORMAT = 'Invalid time format.',
    INVALID_MESSAGE_VERSION = 'Invalid message version.',
    UNABLE_TO_PARSE = 'Unable to parse the message.',
  }

  export class SiweMessage {
    scheme?: string;
    domain: string;
    address: string;
    statement?: string;
    uri: string;
    version: string;
    chainId: number;
    nonce: string;
    issuedAt?: string;
    expirationTime?: string;
    notBefore?: string;
    requestId?: string;
    resources?: string[];

    constructor(param: string | Partial<SiweMessage>);
    toMessage(): string;
    prepareMessage(): string;
    validate(signature: string, provider?: unknown): Promise<SiweMessage>;
    verify(params: VerifyParams, opts?: VerifyOpts): Promise<SiweResponse>;
  }

  /**
   * Generates a cryptographically secure random alphanumeric nonce
   * satisfying EIP-4361 §2.3 (96 bits of entropy).
   */
  export function generateNonce(): string;
  export function isValidISO8601Date(inputDate: string): boolean;
  export function checkInvalidKeys<T>(obj: T, keys: (keyof T)[]): (keyof T)[];
}
