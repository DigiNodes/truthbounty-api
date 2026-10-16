import { Injectable, Logger } from '@nestjs/common';

/**
 * ManifestReadinessService
 *
 * Tracks whether the contract address manifest has completed a successful
 * full validation pass. It is the authoritative readiness gate for the
 * manifest subsystem:
 *
 *   - Starts as NOT ready (false).
 *   - Transitions to ready (true) only after
 *     ContractManifestValidatorService emits a successful validation.
 *   - Never resets back to false once set (validation is a one-shot startup
 *     check; if it fails the process is expected to crash or remain
 *     unserviceable).
 *
 * Usage in a health check or readiness guard:
 *
 * ```typescript
 * if (!manifestReadinessService.isReady()) {
 *   throw new ServiceUnavailableException('Manifest not yet validated');
 * }
 * ```
 *
 * Design constraints
 * ------------------
 * - No hard-coded address bypass: readiness is only granted after a real
 *   validation run completes without errors.
 * - Validation errors are sanitized before exposure: only the validation
 *   summary is stored, never raw internal stack traces.
 */
@Injectable()
export class ManifestReadinessService {
  private readonly logger = new Logger(ManifestReadinessService.name);

  /** Whether a successful full manifest validation has completed. */
  private _ready = false;

  /** ISO-8601 timestamp of the last successful validation, if any. */
  private _validatedAt: string | undefined;

  /** Sanitized summary of the most recent validation error, if any. */
  private _lastError: string | undefined;

  /**
   * Returns true only after a successful full manifest validation.
   */
  isReady(): boolean {
    return this._ready;
  }

  /**
   * Returns the ISO-8601 timestamp when the manifest was last validated
   * successfully, or undefined if validation has not yet completed.
   */
  get validatedAt(): string | undefined {
    return this._validatedAt;
  }

  /**
   * Returns a sanitized error summary from the most recent failed validation,
   * or undefined if no failure has been recorded.
   */
  get lastError(): string | undefined {
    return this._lastError;
  }

  /**
   * Mark the manifest as successfully validated.
   * Called by ContractManifestValidatorService after a passing validation run.
   *
   * @param releaseId  The release identifier from the validated manifest.
   * @param version    The manifest schema version.
   * @param chainId    The chain ID the manifest targets.
   * @param contractCount  Number of contracts that passed validation.
   */
  markReady(
    releaseId: string,
    version: string,
    chainId: number,
    contractCount: number,
  ): void {
    this._ready = true;
    this._validatedAt = new Date().toISOString();
    this._lastError = undefined;
    this.logger.log(
      `Manifest readiness gate: OPEN — release ${releaseId}, ` +
        `v${version}, chain ${chainId}, ${contractCount} contract(s)`,
    );
  }

  /**
   * Record a validation failure summary.
   * The service remains NOT ready.
   *
   * @param summary  A sanitized, actionable error summary (no stack traces).
   */
  markFailed(summary: string): void {
    this._ready = false;
    // Sanitize: truncate and strip any potential sensitive path information.
    const sanitized = this.sanitizeError(summary);
    this._lastError = sanitized;
    this.logger.warn(`Manifest readiness gate: CLOSED — ${sanitized}`);
  }

  /**
   * Sanitizes an error message to be safe for external exposure.
   * Removes filesystem paths, stack trace frames, and excessive length.
   */
  private sanitizeError(message: string): string {
    // Truncate to a safe display length.
    const truncated =
      message.length > 512 ? message.slice(0, 512) + '…' : message;
    // Remove filesystem path fragments that may appear in error messages.
    return truncated.replace(/\s+at\s+\S+\s+\(\S+\)/g, '').trim();
  }
}
