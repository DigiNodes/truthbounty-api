import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AuditActionType,
  AuditCategory,
  AuditEntityType,
  AuditSeverity,
} from '../../audit/entities/audit-log.entity';
import { AuditTrailService } from '../../audit/services/audit-trail.service';
import { validateTargetUrl } from '../../common/security/ssrf/ssrf-url-validator';
import { ConfigureWebhookDto, RotateWebhookSecretDto } from '../dto/configure-webhook.dto';
import { toWebhookAuditMetadata } from '../dto/preferences-response.dto';
import { NotificationPreference } from '../entities/notification-preference.entity';
import { PreferenceEnforcer } from './preference-enforcer.service';
import { WebhookSecretCipher } from './webhook-secret-cipher.service';

/**
 * Dedicated, write-only handling for user-configured webhook signing secrets.
 *
 * A secret is accepted only by `configureWebhook` / `rotateSecret`, is
 * encrypted before persistence, and never appears in a return value, log,
 * trace, metric or audit record. Ordinary preference updates cannot change it.
 */
@Injectable()
export class WebhookPreferencesService {
  private readonly logger = new Logger(WebhookPreferencesService.name);

  constructor(
    @InjectRepository(NotificationPreference)
    private readonly preferenceRepository: Repository<NotificationPreference>,
    private readonly preferenceEnforcer: PreferenceEnforcer,
    private readonly cipher: WebhookSecretCipher,
    private readonly auditTrailService: AuditTrailService,
  ) {}

  /** Create or replace a webhook configuration. Omitted secrets are preserved. */
  async configureWebhook(
    userId: string,
    input: ConfigureWebhookDto,
  ): Promise<NotificationPreference> {
    this.assertAllowedUrl(input.url);

    const preference = await this.preferenceEnforcer.getPreferences(userId);
    const previous = preference.webhookConfig;
    const rotatesSecret = input.secret !== undefined && input.secret !== null;

    preference.webhookConfig = {
      url: input.url,
      events: input.events ? [...input.events] : previous?.events,
      retryAttempts: input.retryAttempts ?? previous?.retryAttempts,
      timeout: input.timeout ?? previous?.timeout,
      secret: rotatesSecret
        ? this.cipher.encrypt(input.secret as string)
        : previous?.secret,
    };

    const saved = await this.persist(userId, preference);
    this.logger.debug(
      `Webhook configured for user ${userId}: secretRotated=${rotatesSecret}, keyId=${this.cipher.getActiveKeyId()}`,
    );
    await this.auditSecretEvent(userId, 'webhook_configured', rotatesSecret, saved, {
      secretConfiguredBefore: Boolean(previous?.secret),
    });
    return saved;
  }

  /** Explicitly rotate the signing secret without altering other webhook metadata. */
  async rotateSecret(
    userId: string,
    input: RotateWebhookSecretDto,
  ): Promise<NotificationPreference> {
    const preference = await this.preferenceEnforcer.getPreferences(userId);
    if (!preference.webhookConfig?.url) {
      throw new BadRequestException('No webhook is configured for this user');
    }

    // Single repository save: the replacement is atomic and the previous
    // signing secret is invalidated immediately (no grace version is stored).
    preference.webhookConfig = {
      ...preference.webhookConfig,
      secret: this.cipher.encrypt(input.secret),
    };

    const saved = await this.persist(userId, preference);
    this.logger.debug(
      `Webhook signing secret rotated for user ${userId}: keyId=${this.cipher.getActiveKeyId()}`,
    );
    await this.auditSecretEvent(userId, 'webhook_secret_rotated', true, saved, {
      secretConfiguredBefore: true,
    });
    return saved;
  }

  /** Remove the webhook configuration and its encrypted secret. */
  async removeWebhook(userId: string): Promise<NotificationPreference> {
    const preference = await this.preferenceEnforcer.getPreferences(userId);
    const hadSecret = Boolean(preference.webhookConfig?.secret);
    preference.webhookConfig = null;

    const saved = await this.persist(userId, preference);
    this.logger.debug(`Webhook removed for user ${userId}: secretRemoved=${hadSecret}`);
    await this.auditSecretEvent(userId, 'webhook_removed', false, saved, {
      secretConfiguredBefore: hadSecret,
    });
    return saved;
  }

  /** Decrypt a stored secret for outbound signature generation only. */
  resolveSigningSecret(stored: string | undefined): string | null {
    if (!stored) return null;
    return this.cipher.decrypt(stored);
  }

  private async persist(
    userId: string,
    preference: NotificationPreference,
  ): Promise<NotificationPreference> {
    preference.lastModifiedAt = new Date();
    return this.preferenceRepository.save(preference);
  }

  /**
   * Reuse the repo's SSRF validator (PREWAVE-BE-150/#850) at configuration
   * time. Error messages deliberately omit the submitted URL.
   */
  private assertAllowedUrl(url: string): void {
    try {
      validateTargetUrl(url);
    } catch {
      throw new BadRequestException('Webhook URL is not allowed');
    }
  }

  private async auditSecretEvent(
    userId: string,
    operation: string,
    secretRotated: boolean,
    preference: NotificationPreference,
    extra: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditTrailService.log({
        actionType: AuditActionType.CONFIG_UPDATED,
        entityType: AuditEntityType.USER,
        entityId: userId,
        userId,
        severity: AuditSeverity.MEDIUM,
        category: AuditCategory.OPERATIONS,
        description: `Webhook configuration changed (${operation})`,
        afterState: toWebhookAuditMetadata(preference),
        metadata: {
          operation,
          secretRotated,
          keyId: this.cipher.getActiveKeyId(),
          ...extra,
        },
      });
    } catch (error) {
      // Auditing must not fail the user operation. Never log request data.
      this.logger.error(
        `Failed to record webhook audit event for user ${userId}: ${(error as Error).message}`,
      );
    }
  }
}
