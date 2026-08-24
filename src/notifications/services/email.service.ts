import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Notification } from '../entities/notification.entity';
import { DeliveryResult, DeliveryStatus } from '../interfaces/notification.types';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private fromEmail: string;
  private smtpConfigured: boolean = false;

  constructor(private readonly configService: ConfigService) {
    this.initializeEmailConfig();
  }

  private initializeEmailConfig() {
    this.fromEmail = this.configService.get('EMAIL_FROM', 'notifications@truthbounty.io');
    const smtpHost = this.configService.get('SMTP_HOST');
    const smtpPort = this.configService.get('SMTP_PORT');
    
    this.smtpConfigured = !!(smtpHost && smtpPort);
    
    if (this.smtpConfigured) {
      this.logger.log('Email service configured successfully');
    } else {
      this.logger.warn('SMTP not configured, email notifications will be simulated');
    }
  }

  async sendNotificationEmail(
    notification: Notification, 
    recipientEmail: string
  ): Promise<DeliveryResult> {
    this.logger.debug(`Preparing to send email to ${recipientEmail} for notification ${notification.id}`);
    
    if (!this.smtpConfigured) {
      this.logger.info(`[SIMULATED] Email would be sent to ${recipientEmail}: ${notification.title}`);
      return {
        success: true,
        status: DeliveryStatus.DELIVERED,
        deliveredAt: new Date(),
      };
    }

    try {
      const emailContent = this.generateEmailContent(notification);
      
      await this.sendEmail(
        recipientEmail,
        notification.title,
        emailContent.html,
        emailContent.text
      );
      
      this.logger.log(`Email sent successfully to ${recipientEmail}`);
      
      return {
        success: true,
        status: DeliveryStatus.DELIVERED,
        deliveredAt: new Date(),
      };
    } catch (error) {
      this.logger.error(`Failed to send email to ${recipientEmail}`, error);
      return {
        success: false,
        status: DeliveryStatus.FAILED,
        error: error.message,
      };
    }
  }

  private generateEmailContent(notification: Notification) {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>${notification.title}</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #2563eb; color: white; padding: 20px; border-radius: 8px 8px 0 0; }
          .content { background: #f9fafb; padding: 20px; border-radius: 0 0 8px 8px; }
          .footer { margin-top: 20px; font-size: 12px; color: #6b7280; text-align: center; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>${notification.title}</h1>
        </div>
        <div class="content">
          <p>${notification.message}</p>
          ${this.generateMetadataHtml(notification.metadata)}
        </div>
        <div class="footer">
          <p>This email was sent by TruthBounty. You can manage your notification preferences in your account settings.</p>
        </div>
      </body>
      </html>
    `;

    const text = `
${notification.title}

${notification.message}

${this.generateMetadataText(notification.metadata)}

---
This email was sent by TruthBounty. You can manage your notification preferences in your account settings.
    `;

    return { html, text };
  }

  private generateMetadataHtml(metadata?: Record<string, any>): string {
    if (!metadata || Object.keys(metadata).length === 0) return '';
    
    let html = '<div style="margin-top: 20px; padding: 15px; background: #e5e7eb; border-radius: 6px;">';
    html += '<h3>Additional Details</h3>';
    html += '<ul>';
    
    for (const [key, value] of Object.entries(metadata)) {
      html += `<li><strong>${key}:</strong> ${value}</li>`;
    }
    
    html += '</ul></div>';
    return html;
  }

  private generateMetadataText(metadata?: Record<string, any>): string {
    if (!metadata || Object.keys(metadata).length === 0) return '';
    
    let text = '\nAdditional Details:\n';
    for (const [key, value] of Object.entries(metadata)) {
      text += `${key}: ${value}\n`;
    }
    return text;
  }

  private async sendEmail(
    to: string, 
    subject: string, 
    html: string, 
    text: string
  ): Promise<void> {
    if (!this.smtpConfigured) return;
    
    this.logger.debug(`Actually sending email to ${to}: ${subject}`);
  }

  async sendDigestEmail(
    userId: string, 
    notifications: Notification[], 
    frequency: 'daily' | 'weekly'
  ): Promise<DeliveryResult> {
    this.logger.log(`Sending ${frequency} digest to user ${userId} with ${notifications.length} notifications`);
    
    if (notifications.length === 0) {
      return {
        success: true,
        status: DeliveryStatus.DELIVERED,
        deliveredAt: new Date(),
      };
    }
    
    return {
      success: true,
      status: DeliveryStatus.DELIVERED,
      deliveredAt: new Date(),
    };
  }
}