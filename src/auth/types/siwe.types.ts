/**
 * SIWE (Sign-In with Ethereum) types — EIP-4361
 * https://eips.ethereum.org/EIPS/eip-4361
 */

export interface SiweMessage {
  /** RFC 4501 dnsauthority that is requesting the signing */
  domain: string;
  /** Ethereum address performing the signing */
  address: string;
  /** Human-readable ASCII assertion the user signs (optional) */
  statement?: string;
  /** RFC 3986 URI referring to the resource that is the subject of the signing */
  uri: string;
  /** Current version of the SIWE message (default: '1') */
  version: string;
  /** EIP-155 Chain ID */
  chainId: number;
  /** Randomized token used to prevent replay attacks */
  nonce: string;
  /** ISO 8601 datetime string of the current time */
  issuedAt: string;
  /** ISO 8601 datetime string that the signing is valid until (optional) */
  expirationTime?: string;
  /** ISO 8601 datetime string that the signing is not valid before (optional) */
  notBefore?: string;
  /** Human-readable identifier of the requesting resource (optional) */
  requestId?: string;
  /** System-specific resources (optional) */
  resources?: string[];
}

export interface ParsedSiweMessage extends SiweMessage {
  /** The raw message string that was signed */
  rawMessage: string;
}

export interface SiweVerifyParams {
  message: string;
  signature: string;
  /** Expected domain to validate against (strict when allowlist is empty) */
  expectedDomain?: string;
  /** Require the message URI origin to match this exact origin */
  expectedOrigin?: string;
  /** Require the message chain ID to match (EIP-155, e.g. 10 for Optimism) */
  expectedChainId?: number;
  /** Expected statement the user must have signed (when the API enforces one) */
  expectedStatement?: string;
  /** Allowlisted origins. Non-empty ⇒ the message URI origin must be a member. */
  allowedOrigins?: string[];
  /** Allowlisted domains. Non-empty ⇒ the message domain must be a member. */
  allowedDomains?: string[];
  /** Supported EIP-155 chain IDs. Non-empty ⇒ the message chain must be a member. */
  supportedChainIds?: number[];
}

export interface SiweVerifyResult {
  success: boolean;
  data?: ParsedSiweMessage;
  error?: string;
  address?: string;
}
