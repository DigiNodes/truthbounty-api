import { Injectable, Logger, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { NotificationChannel, ChannelDeliveryResult, RenderedNotificationPayload } from './channel.interface';
import { DeliveryChannel } from '../interfaces/notification.types';
import { PreferenceEnforcer } from '../services/preference-enforcer.service';
import { firstValueFrom } from 'rxjs';
import { escapeHtml, sanitizeActionUrl } from '../notification-templates';
import * as nodemailer from 'nodemailer';
import { SmtpConfigService } from './smtp-config.service';
import { UnsubscribeTokenService } from '../services/unsubscribe-token.service';

/**
 * EmailChannel
 * 
 * Sends notifications via email through a configured email service.
 * Supports multiple providers:
 * - SMTP (direct mail server)
 * - Mailgun
 * - SendGrid
 * - AWS SES
 * 
 * Features:
 * - Template-based HTML emails
 * - Rate limiting (max emails per day)
 * - Unsubscribe link generation
 * - Retry on transient failures
 * - Delivery tracking
 */
@Injectable()
export class EmailChannel implements NotificationChannel {
  readonly channelType: DeliveryChannel = DeliveryChannel.EMAIL;
  private readonly logger = new Logger(EmailChannel.name);

  private readonly emailProvider: string;
  private readonly fromAddress: string;
  private readonly smtpHost?: string;
  private readonly smtpPort?: number;
  private readonly smtpUser?: string;
  private readonly smtpPassword?: string;
  private readonly mailgunDomain?: string;
  private readonly mailgunKey?: string;
  private readonly sendgridKey?: string;
  private smtpTransporter: nodemailer.Transporter | null = null;

  constructor(
    private httpService: HttpService,
    private configService: ConfigService,
    private preferenceEnforcer: PreferenceEnforcer,
    @Optional() private smtpConfigService?: SmtpConfigService,
    @Optional() private unsubscribeTokenService?: UnsubscribeTokenService,
  ) {
    this.emailProvider = this.configService.get<string>(
      'NOTIFICATION_EMAIL_PROVIDER',
      'smtp',
    );
    this.fromAddress =
      this.configService.get<string>('NOTIFICATION_EMAIL_FROM') ||
      'notifications@truthbounty.io';
    this.smtpHost = this.configService.get<string>('SMTP_HOST');
    this.smtpPort = this.configService.get<number>('SMTP_PORT', 587);
    this.smtpUser = this.configService.get<string>('SMTP_USER');
    this.smtpPassword = this.configService.get<string>('SMTP_PASSWORD');
    this.mailgunDomain = this.configService.get<string>('MAILGUN_DOMAIN');
    this.mailgunKey = this.configService.get<string>('MAILGUN_API_KEY');
    this.sendgridKey = this.configService.get<string>('SENDGRID_API_KEY');

    // Initialize SMTP transporter if configured
    if (this.emailProvider === 'smtp') {
      this.initializeSmtpTransporter();
    }
  }

  /**
   * Initialize SMTP transporter with connection pooling.
   * Called once during service construction.
   */
  private initializeSmtpTransporter(): void {
    if (!this.smtpConfigService) {
      this.logger.warn(
        'SMTP config service not available. Email delivery via SMTP will fail.',
      );
      return;
    }
    const smtpConfig = this.smtpConfigService.getConfig();
    
    if (!smtpConfig) {
      const errors = this.smtpConfigService.getErrors();
      this.logger.warn(
        `SMTP not configured properly: ${errors.join(', ')}. Email delivery via SMTP will fail.`
      );
      return;
    }

    try {
      this.smtpTransporter = nodemailer.createTransport({
        host: smtpConfig.host,
        port: smtpConfig.port,
        secure: smtpConfig.secure,
        auth: {
          user: smtpConfig.auth.user,
          pass: smtpConfig.auth.pass,
        },
        connectionTimeout: smtpConfig.connectionTimeout,
        greetingsTimeout: smtpConfig.greetingsTimeout,
        pool: true, // Use connection pooling
        maxConnections: 5,
        maxMessages: 100,
      });

      this.logger.log(
        `SMTP transporter initialized: ${smtpConfig.host}:${smtpConfig.port} (secure: ${smtpConfig.secure})`
      );
    } catch (error) {
      this.logger.error(
        `Failed to initialize SMTP transporter: ${error.message}`,
        error.stack
      );
      this.smtpTransporter = null;
    }
  }

  async isEnabled(userId: string): Promise<boolean> {
    return this.preferenceEnforcer.isChannelEnabled(userId, 'EMAIL' as any);
  }

  async send(payload: RenderedNotificationPayload): Promise<ChannelDeliveryResult> {
    try {
      // Get user's email address
      const toEmail = await this.preferenceEnforcer.getNotificationEmail(payload.userId);

      if (!toEmail) {
        return {
          success: false,
          error: 'User has no email configured',
        };
      }

      // Generate unsubscribe token
      const unsubscribeToken = this.generateUnsubscribeToken(payload.userId);

      // Build email
      const emailData = {
        to: toEmail,
        from: this.fromAddress,
        subject: payload.rendered.subject || `TruthBounty: ${payload.eventType}`,
        html: this.buildHtmlEmail(
          payload.rendered.html || payload.rendered.body,
          payload.rendered.actionUrl,
          unsubscribeToken,
        ),
        text: payload.rendered.body,
        metadata: {
          notificationId: payload.metadata.notificationId,
          userId: payload.userId,
          eventType: payload.eventType,
        },
      };

      // Send via configured provider
      let messageId: string;
      switch (this.emailProvider) {
        case 'mailgun':
          messageId = await this.sendViaMailgun(emailData);
          break;
        case 'sendgrid':
          messageId = await this.sendViaSendGrid(emailData);
          break;
        case 'smtp':
        default:
          messageId = await this.sendViaSMTP(emailData);
          break;
      }

      this.logger.debug(`Email sent to ${toEmail} (messageId: ${messageId})`);

      return {
        success: true,
        deliveryTimestamp: new Date(),
        channelMessageId: messageId,
      };
    } catch (error) {
      this.logger.error(
        `Failed to send email notification to ${payload.userId}: ${error.message}`,
      );

      return {
        success: false,
        error: error.message,
      };
    }
  }

  async validateConfig(userId: string): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];

    // Check if provider is configured
    if (!this.emailProvider) {
      errors.push('Email provider not configured');
      return { valid: false, errors };
    }

    // Check provider-specific config
    switch (this.emailProvider) {
      case 'mailgun':
        if (!this.mailgunDomain || !this.mailgunKey) {
          errors.push('Mailgun not properly configured');
        }
        break;
      case 'sendgrid':
        if (!this.sendgridKey) {
          errors.push('SendGrid API key not configured');
        }
        break;
      case 'smtp':
        // Use SmtpConfigService for comprehensive validation
        const smtpValidation = this.smtpConfigService.validateConfig();
        if (!smtpValidation.valid) {
          errors.push(...smtpValidation.errors);
        }

        // Optional: Test SMTP connection (can be expensive, only if config is valid)
        if (smtpValidation.valid && this.smtpTransporter) {
          try {
            await this.smtpTransporter.verify();
          } catch (error) {
            errors.push(`SMTP connection test failed: ${error.message}`);
          }
        }
        break;
    }

    // Check user has email
    const email = await this.preferenceEnforcer.getNotificationEmail(userId);
    if (!email) {
      errors.push('User has no email configured');
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Send via Mailgun API
   */
  private async sendViaMailgun(emailData: any): Promise<string> {
    const data = new URLSearchParams();
    data.append('from', emailData.from);
    data.append('to', emailData.to);
    data.append('subject', emailData.subject);
    data.append('html', emailData.html);
    data.append('text', emailData.text);

    const response = await firstValueFrom(
      this.httpService.post(
        `https://api.mailgun.net/v3/${this.mailgunDomain}/messages`,
        data,
        {
          auth: {
            username: 'api',
            password: this.mailgunKey,
          },
        },
      ),
    );

    return response.data.id;
  }

  /**
   * Send via SendGrid API
   */
  private async sendViaSendGrid(emailData: any): Promise<string> {
    const response = await firstValueFrom(
      this.httpService.post(
        'https://api.sendgrid.com/v3/mail/send',
        {
          personalizations: [{ to: [{ email: emailData.to }] }],
          from: { email: emailData.from },
          subject: emailData.subject,
          content: [
            { type: 'text/plain', value: emailData.text },
            { type: 'text/html', value: emailData.html },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${this.sendgridKey}`,
          },
        },
      ),
    );

    return response.headers['x-message-id'] || `sendgrid-${Date.now()}`;
  }

  /**
   * Send via SMTP using nodemailer.
   * Returns provider-confirmed message ID or throws on failure.
   * 
   * Security: Never logs SMTP credentials. Redacts recipient email from logs.
   * 
   * Error Classification:
   * - Connection timeout: retryable
   * - Authentication failure: permanent
   * - Invalid recipient: permanent
   * - TLS/SSL error: permanent
   * - Provider rejection (5xx): check response code for retry
   */
  private async sendViaSMTP(emailData: any): Promise<string> {
    // Fail-closed: validate configuration
    if (!this.smtpTransporter) {
      throw new Error('SMTP not configured');
    }

    const smtpConfig = this.smtpConfigService.getConfig();
    if (!smtpConfig) {
      throw new Error('SMTP configuration invalid');
    }

    try {
      // Send email via nodemailer
      const info = await this.smtpTransporter.sendMail({
        from: `${smtpConfig.from.name} <${smtpConfig.from.address}>`,
        to: emailData.to,
        subject: emailData.subject,
        text: emailData.text,
        html: emailData.html,
      });

      // Fail-closed: require provider-confirmed message ID
      if (!info.messageId) {
        throw new Error('SMTP provider did not return message ID');
      }

      // Log success without PII
      this.logger.debug(
        `SMTP email sent successfully (messageId: ${info.messageId})`,
        {
          messageId: info.messageId,
          accepted: info.accepted?.length || 0,
          rejected: info.rejected?.length || 0,
        }
      );

      return info.messageId;
    } catch (error) {
      // Classify error for retry logic
      const errorCode = error.code || 'UNKNOWN';
      const isRetryable = this.isSmtpErrorRetryable(error);

      // Log error without exposing credentials or PII
      this.logger.error(
        `SMTP delivery failed: ${error.message} (code: ${errorCode}, retryable: ${isRetryable})`,
        {
          errorCode,
          isRetryable,
          command: error.command,
          // Never log credentials or recipient email
        }
      );

      throw error;
    }
  }

  /**
   * Classify SMTP errors as retryable or permanent.
   * 
   * Retryable: Connection timeout, temporary server errors
   * Permanent: Authentication failure, invalid recipient, TLS errors
   */
  private isSmtpErrorRetryable(error: any): boolean {
    const errorCode = error.code || '';
    const responseCode = error.responseCode || 0;

    // Connection/timeout errors - retryable
    if (errorCode === 'ETIMEDOUT' || errorCode === 'ECONNECTION' || 
        errorCode === 'ESOCKET' || errorCode === 'ECONNREFUSED') {
      return true;
    }

    // Authentication errors - permanent
    if (errorCode === 'EAUTH' || responseCode === 535) {
      return false;
    }

    // TLS/SSL errors - permanent
    if (errorCode === 'ETLS' || errorCode === 'ECERT') {
      return false;
    }

    // Invalid recipient - permanent
    if (responseCode >= 500 && responseCode < 600) {
      return false;
    }

    // Temporary server errors - retryable
    if (responseCode >= 400 && responseCode < 500) {
      return true;
    }

    // Unknown errors - retryable (safe default)
    return true;
  }

  /**
   * Build HTML email with header, body, footer, and unsubscribe link
   */
  private buildHtmlEmail(body: string, actionUrl?: string, unsubscribeToken?: string): string {
    const safeActionUrl = sanitizeActionUrl(actionUrl);
    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif; color: #333; }
        .email-container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { text-align: center; margin-bottom: 30px; }
        .logo { font-size: 24px; font-weight: bold; color: #000; }
        .content { background: #f9f9f9; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
        .cta-button { display: inline-block; background: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; margin-top: 20px; }
        .footer { text-align: center; color: #666; font-size: 12px; margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; }
        .unsubscribe-link { color: #007bff; text-decoration: none; }
    </style>
</head>
<body>
    <div class="email-container">
        <div class="header">
            <div class="logo">TruthBounty</div>
        </div>
        
        <div class="content">
            ${body}
            ${
              safeActionUrl
                ? `<a href="${escapeHtml(safeActionUrl)}" class="cta-button">View More</a>`
                : ''
            }
        </div>
        
        <div class="footer">
            <p>
                <a href="https://truthbounty.io" style="color: #007bff; text-decoration: none;">Visit TruthBounty</a> | 
                ${
                  unsubscribeToken
                    ? `<a href="https://truthbounty.io/unsubscribe/${unsubscribeToken}" class="unsubscribe-link">Unsubscribe</a>`
                    : ''
                }
            </p>
            <p>&copy; ${new Date().getFullYear()} TruthBounty. All rights reserved.</p>
        </div>
    </div>
</body>
</html>
    `.trim();
  }

  generateUnsubscribeToken(userId: string): string {
    if (this.unsubscribeTokenService) {
      return this.unsubscribeTokenService.generateToken({
        userId,
        channel: DeliveryChannel.EMAIL,
      });
    }

    // Fail-safe cryptographically secure token generator
    const fallbackService = new UnsubscribeTokenService(this.configService);
    return fallbackService.generateToken({
      userId,
      channel: DeliveryChannel.EMAIL,
    });
  }
}
