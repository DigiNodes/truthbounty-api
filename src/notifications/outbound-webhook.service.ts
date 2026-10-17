import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@typeorm/nestjs-typeorm';
import { Repository } from 'typeorm';
import { createHmac, randomUUID, randomBytes } from 'crypto';
import { promises as dns } from 'dns';
import { isIP } from 'net';
import { WebhookEndpointEntity, WebhookEndpointStatus } from './entities/webhook-endpoint.entity';
import {
  WebhookDeliveryEntity,
  WebhookDeliveryStatus,
} from './entities/webhook-delivery.entity';

export const WEBHOOK_ENVELOPE_VERSION = 'v1';
export const WEBHOOK_SIGNATURE_HEADER = 'X-Webhook-Signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'X-Webhook-Timestamp';
export const WEBHOOK_ID_HEADER = 'X-Webhook-Id';
export const WEBHOOK_EVENT_HEADER = 'X-Webhook-Event';
export const WEBHOOK_ATTEMPT_HEADER = 'X-Webhook-Attempt';

/** Default maximum replay window in seconds. */
export const DEFAULT_MAX_SKEW = 300;

export interface WebhookEnvelope<T=unknown> {
  id: string;
  type: string;
  version: string;
  timestamp: number;
  attempt: number;
  data: T;
}

export interface EndpointInput {
  url: string;
  ownerId?: string | null;
  eventTypes?: string[];
  maxAttempts?: number;
  timeoutMs?: number;
  headers?: Record<string, string> | null;
}

export interface DeliverOptions {
  /** Canonical event identifier. Drives the stable delivery ID. */
  eventId?: string;
  /** Override the default retry delays (ms). */
  retryDelaysMs?: number[];
  /** Maximum attempts (overrides endpoint config). */
  maxAttempts?: number;
}

const DEFAULT_RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 32000];
const MAX_RESPONSE_BODY_LENGTH = 4096;

@Injectable()
export class OutboundWebhookService {
  private readonly logger = new Logger(OutboundWebhookService.name);

  constructor(
    @InjectRepository(WebhookEndpointEntity)
    private readonly endpointsRepo: Repository<WebhookEndpointEntity>,
    @InjectRepository(WebhookDeliveryEntity)
    private readonly deliveriesRepo: Repository<WebhookDeliveryEntity>,
  ) {}

  // ------------------------------------------------------------------------
  // Endpoint management
  // ------------------------------------------------------------------------

  async registerEndpoint(input: EndpointInput): Promise<WebhookEndpointEntity> {
    await this.validateEndpointUrl(input.url);

    const secret = randomBytes(32).toString('hex');
    const endpoint = this.endpointsRepo.create({
      url: input.url,
      ownerId: input.ownerId ?? null,
      secret,
      secretVersion: 1,
      previousSecret: null,
      previousSecretVersion: null,
      previousSecretExpiresAt: null,
      status: WebhookEndpointStatus.ACTIVE,
      eventTypes: input.eventTypes ?? [],
      maxAttempts: input.maxAttempts ?? 5,
      timeoutMs: input.timeoutMs ?? 10000,
      headers: input.headers ?? null,
    });
    return this.endpointsRepo.save(endpoint);
  }

  async rotateSecret(endpointId: string, gracePeriodMs = 86_400_000): Promise<WebhookEndpointEntity> {
    const endpoint = await this.getEndpointOrFail(endpointId);
    const newSecret = randomBytes(32).toString('hex');
    endpoint.previousSecret = endpoint.secret;
    endpoint.previousSecretVersion = endpoint.secretVersion;
    endpoint.previousSecretExpiresAt = new Date(Date.now() + gracePeriodMs);
    endpoint.secret = newSecret;
    endpoint.secretVersion += 1;
    return this.endpointsRepo.save(endpoint);
  }

  async disableEndpoint(endpointId: string): Promise<void> {
    const endpoint = await this.getEndpointOrFail(endpointId);
    endpoint.status = WebhookEndpointStatus.DISABLED;
    await this.endpointsRepo.save(endpoint);
  }

  async getEndpointOrFail(endpointId: string): Promise<WebhookEndpointEntity> {
    const endpoint = await this.endpointsRepo.findOneBy({ id: endpointId });
    if (!endpoint) {
      throw new NotFoundException(`Webhook endpoint ${endpointId} not found`);
    }
    return endpoint;
  }

  /**
   * Validate an endpoint URL for safety (SSRF protection).
   * Rejects non-HTTPS, private/loopback/link local/internal addresses.
   */
  async validateEndpointUrl(rawUrl: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new BadRequestException('Webhook URL is not a valid absolute URL');
    }

    if (parsed.protocol !== 'https:') {
      throw new BadRequestException('Webhook URL must use https');
    }

    if (parsed.username || parsed.password) {
      throw new BadRequestException('Webhook URL must not contain credentials');
    }

    const hostname = parsed.hostname.toLowerCase();
    if (!hostname) {
      throw new BadRequestException('Webhook URL must include a hostname');
    }

    // Block obvious local names before resolving.
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.local') ||
      hostname === '[localhost]' ||
      hostname === '[o::1]'
    ) {
      throw new BadRequestException('Webhook URL must not target local hosts');
    }

    // If the hostname is a literal IP, validate directly.
    if (isIP(hostname)) {
      if (this.isUnsafeIp(hostname)) {
        throw new BadRequestException('Webhook URL must not target private or internal addresses');
      }
      return;
    }

    // Resolve the hostname and reject if any resolved address is unsafe.
    let addresses: string[];
    try {
      addresses = await this.resolveHostname(hostname);
    } catch {
      throw new BadRequestException('Webhook URL hostname could not be resolved');
    }

    if (addresses.length === 0) {
      throw new BadRequestException('Webhook URL hostname did not resolve to any address');
    }

    for (const address of addresses) {
      if (this.isUnsafeIp(address)) {
        throw new BadRequestException('Webhook URL must not target private or internal addresses');
      }
    }
  }

  // ------------------------------------------------------------------------
  // Delivery
  // ------------------------------------------------------------------------

  /**
   * Deliver a logical event to an endpoint. Retries are bounded by the endpoint's `maxAttempts`.
   * Returns the final delivery audit record.
   */
  async deliver(
    endpointId: string,
    eventType: string,
    payload: unknown,
    options: DeliverOptions = {},
  ): Promise<WebhookDeliveryEntity> {
    const endpoint = await this.getEndpointOrFail(endpointId);
    if (endpoint.status !== WebhookEndpointStatus.ACTIVE) {
      throw new BadRequestException(`Webhook endpoint ${endpointId} is not active`);
    }
    if (
      endpoint.eventTypes.length > 0 &&
      !endpoint.eventTypes.includes(eventType)
    ) {
      throw new BadRequestException(
        `Webhook endpoint ${endpointId} is not subscribed to event ${eventType}`,
      );
    }

    // Re-validate at delivery time to close the TOCTU-DNS window.
    await this.validateEndpointUrl(endpoint.url);

    const deliveryId = this.deriveDeliveryId(endpointId, eventType, options.eventId);
    const maxAttempts = Math.min(Math.max(1, options.maxAttempts ?? endpoint.maxAttempts), 10);
    const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

    let last: WebhookDeliveryEntity | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const record = await this.attemptDelivery(
        endpoint,
        deliveryId,
        eventType,
        payload,
        attempt,
      );
      last = record;

      if (record.status === WebhookDeliveryStatus.SUCCEEDED) {
        return record;
      }

      if (attempt < maxAttempts) {
        const delay = retryDelays[Math.min(attempt - 1, retryDelays.length - 1)];
        await this.sleep(delay);
      }
    }

    return last as WebhookDeliveryEntity;
  }

  /**
   * Perform a single delivery attempt and persist an audit record.
   */
  private async attemptDelivery(
    endpoint: WebhookEndpointEntity,
    deliveryId: string,
    eventType: string,
    payload: unknown,
    attempt: number,
  ): Promise<WebhookDeliveryEntity> {
    const timestamp = Math.floor(Date.now() / 1000);
    const envelope: WebhookEnvelope = {
      id: deliveryId,
      type: eventType,
      version: WEBHOOK_ENVELOPE_VERSION,
      timestamp,
      attempt,
      data: payload,
    };
    const body = JSON.stringify(envelope);
    const signature = this.sign(envelope, endpoint.secret);

    const record = this.deliveriesRepo.create({
      deliveryId,
      endpointId: endpoint.id,
      eventType,
      attempt,
      status: WebhookDeliveryStatus.PENDING,
      responseStatus: null,
      responseBody: null,
      errorMessage: null,
      signature,
      secretVersion: endpoint.secretVersion,
      timestamp: String(timestamp),
      durationMs: null,
      nextRetryAt: null,
    });

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), endpoint.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'TruthBounty-Webhooks/1',
        [WEBHOOK_ID_HEADER]: deliveryId,
        [WEBHOOK_EVENT_HEADER]: eventType,
        [WEBHOOK_TIMESTAMP_HEADER]: String(timestamp),
        [WEBHOOK_SIGNATURE_HEADER]: `sha256=${signature}`,
        [WEBHOOK_ATTEMPT_HEADER]: String(attempt),
        ...(endpoint.headers ?? {}),
      };

      const response = await fetch(endpoint.url, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual', // Redirects are rejected to avoid SSRF via redirect.
        signal: controller.signal,
      });

      const durationMs = Date.now() - startedAt;
      const responseBody = await this.safelyReadBody(response);

      if (response.status >= 300 && response.status < 400) {
        record.status = WebhookDeliveryStatus.FAILED;
        record.responseStatus = response.status;
        record.responseBody = responseBody;
        record.errorMessage = 'Redirects are not allowed for webhook deliveries';
        record.durationMs = durationMs;
        return this.deliveriesRepo.save(record);
      }

      if (response.status >= 200 && response.status < 300) {
        record.status = WebhookDeliveryStatus.SUCCEEDED;
        record.responseStatus = response.status;
        record.responseBody = responseBody;
        record.durationMs = durationMs;
        return this.deliveriesRepo.save(record);
      }

      // 4xx and 5xx are retried until the bound is reached.
      record.status = WebhookDeliveryStatus.FAILED;
      record.responseStatus = response.status;
      record.responseBody = responseBody;
      record.errorMessage = `Receiver responded with status ${response.status}`;
      record.durationMs = durationMs;
      return this.deliveriesRepo.save(record);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const isTimeout = (error as Error).name === 'AbortError';
      record.status = WebhookDeliveryStatus.FAILED;
      record.errorMessage = isTimeout
        ? `Receiver timed out after ${endpoint.timeoutMs}ms`
        : (error as Error).message;
      record.durationMs = durationMs;
      return this.deliveriesRepo.save(record);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Stable delivery ID for a logical event. Derived deterministically from
   * (endpoint, eventType, eventId) so duplicate enqueues collapse onto the same id.
   */
  deriveDeliveryId(endpointId: string, eventType: string, eventId?: string): string {
    const key = eventId ? `${endpointId}:${eventType}:${eventId}` : randomUUID();
    return createHmac('sha256').update(key).digest('hex');
  }

  /**
   * Compute the HMAC-SHA256 signature over the canonical signing string.
   * The signing string is `${timestamp}.${body}` where body is the exact JSON
   * serialization of the envelope. Receivers must reproduce this exactly.
   */
  sign(envelope: WebhookEnvelope, secret: string): string {
    const body = JSON.stringify(envelope);
    const signingString = `${envelope.timestamp}.${body}`;
    return createHmac('sha256', secret).update(signingString).digest('hex');
  }

  /**
   * Verify a signature against an endpoint's current or previous secret.
   * Returns true if the signature is valid and the timestamp is within the window.
   */
  async verifySignature(
    endpointId: string,
    envelope: WebhookEnvelope,
    signature: string,
    maxSkewSeconds = DEFAULT_MAX_SKEW,
  ): Promise<boolean> {
    const endpoint = await this.getEndpointOrFail(endpointId);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - envelope.timestamp) > maxSkewSeconds) {
      return false;
    }

    const candidates: string[] = [this.sign(envelope, endpoint.secret)];
    if (
      endpoint.previousSecret &&
      (!endpoint.previousSecretExpiresAt ||
        endpoint.previousSecretExpiresAt > new Date())
    ) {
      candidates.push(this.sign(envelope, endpoint.previousSecret));
    }

    const provided = signature.startsWith('sha256=')
      ? signature.slice('sha256='.length)
      : signature;
    return candidates.some((c) => this.timingSafeEqual(provided, c));
  }

  /** Return the audit history for a logical delivery ID. */
  async getDeliveryHistory(deliveryId: string): Promise<WebhookDeliveryEntity[]> {
    return this.deliveriesRepo.find({
      where: { deliveryId },
      order: { attempt: 'ASC' },
    });
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private async resolveHostname(hostname: string): Promise<string[]> {
    const results = await dns.lookup(hostname, { all: true });
    return results.map((r) => r.address);
  }

  private isUnsafeIp(address: string): boolean {
    const family = isIP(address);
    if (family === 4) {
      const parts = address.split('.').map(Number);
      const [a, b, c] = parts;
      // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8
      if (a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 127) return true;
      // 0.0.0.0/8
      if (a === 0) return true;
      // 169.254.0.0/16 (link local)
      if (a === 169 && b === 254) return true;
      // 100.64.0.0/10 (CGN-NAT)
      if (a === 100 && b >= 64 && b <= 127) return true;
      // 192.0.0.0/24 (IET-TF)
      if (a === 192 && b === 0 && c === 0) return true;
      // 198.18.0.0/15 (benchmark)
      if (a === 198 && b === 18) return true;
      // 224.0.0.0/4 (multicast) and 240.0.0.0/4 (reserved)
      if (a >= 224) return true;
      return false;
    }
    if (family === 6) {
      const normalized = address.toLowerCase();
      if (normalized === '::1' || normalized === '::') {
        return true;
      }
      // fc00::/8 (unique local), fe80::/10 (link local)
      if (
        normalized.startsWith('fc') ||
        normalized.startsWith('fd') ||
        normalized.startsWith('fe8') ||
        normalized.startsWith('fe9') ||
        normalized.startsWith('fea') ||
        normalized.startsWith('feb')
      ) {
        return true;
      }
      // ::ffff:IP v4-mapped
      if (normalized.startsWith('::ffff:')) {
        const mapped = normalized.slice('::ffff:'.length);
        if (isIP(mapped) === 4) {
          return this.isUnsafeIp(mapped);
        }
      }
      return false;
    }
    return true;
  }

  private async safelyReadBody(response: Response): Promise<string | null> {
    try {
      const text = await response.text();
      return text.length > MAX_RESPONSE_BODY_LENGTH
        ? text.slice(0, MAX_RESPONSE_BODY_LENGTH)
        : text;
    } catch {
      return null;
    }
  }

  private timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return diff === 0;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
