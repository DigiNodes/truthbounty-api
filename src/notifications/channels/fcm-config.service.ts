import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';

/**
 * FCM Configuration Service
 * 
 * Initializes Firebase Admin SDK and provides access to FCM messaging.
 * Supports both file-based and inline JSON service account configuration.
 * 
 * Security: Never logs service account credentials or private keys.
 */
@Injectable()
export class FcmConfigService implements OnModuleInit {
  private readonly logger = new Logger(FcmConfigService.name);
  private app: admin.app.App | null = null;
  private initializationError: Error | null = null;

  constructor(private configService: ConfigService) {}

  /**
   * Initialize Firebase Admin SDK on module initialization.
   * Attempts to load service account from path or inline JSON.
   */
  onModuleInit() {
    try {
      this.initializeFirebase();
    } catch (error) {
      this.logger.error(
        `Failed to initialize Firebase Admin SDK: ${error.message}`,
        error.stack
      );
      this.initializationError = error;
    }
  }

  /**
   * Initialize Firebase Admin SDK with service account credentials.
   * Supports two configuration methods:
   * 1. FCM_SERVICE_ACCOUNT_PATH - path to JSON file
   * 2. FCM_SERVICE_ACCOUNT_JSON - inline JSON string
   */
  private initializeFirebase(): void {
    const serviceAccountPath = this.configService.get<string>('FCM_SERVICE_ACCOUNT_PATH');
    const serviceAccountJson = this.configService.get<string>('FCM_SERVICE_ACCOUNT_JSON');

    if (!serviceAccountPath && !serviceAccountJson) {
      this.logger.warn(
        'FCM not configured - push notifications will fail. ' +
        'Set FCM_SERVICE_ACCOUNT_PATH or FCM_SERVICE_ACCOUNT_JSON to enable FCM delivery.'
      );
      return;
    }

    try {
      let credential: admin.credential.Credential;

      if (serviceAccountJson) {
        // Parse inline JSON
        const serviceAccount = JSON.parse(serviceAccountJson);
        credential = admin.credential.cert(serviceAccount);
        this.logger.log('FCM initialized with inline service account JSON');
      } else if (serviceAccountPath) {
        // Load from file path
        credential = admin.credential.cert(serviceAccountPath);
        this.logger.log(`FCM initialized with service account from ${serviceAccountPath}`);
      } else {
        // Should never reach here due to early return above
        throw new Error('No FCM service account configuration provided');
      }

      // Initialize Firebase Admin app
      this.app = admin.initializeApp({
        credential,
      });

      this.logger.log('Firebase Admin SDK initialized successfully');
    } catch (error) {
      this.logger.error(
        `Failed to initialize Firebase Admin SDK: ${error.message}`,
        error.stack
      );
      this.app = null;
      throw error;
    }
  }

  /**
   * Get Firebase Messaging instance.
   * Returns null if FCM is not configured or initialization failed.
   */
  getMessaging(): admin.messaging.Messaging | null {
    if (!this.app) {
      return null;
    }

    try {
      return admin.messaging(this.app);
    } catch (error) {
      this.logger.error(
        `Failed to get Firebase Messaging instance: ${error.message}`,
        error.stack
      );
      return null;
    }
  }

  /**
   * Check if FCM is properly configured and initialized.
   */
  isConfigured(): boolean {
    return this.app !== null;
  }

  /**
   * Get initialization error if configuration failed.
   */
  getInitializationError(): Error | null {
    return this.initializationError;
  }

  /**
   * Validate FCM configuration without initializing.
   * Returns errors if configuration is incomplete.
   */
  validateConfig(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    const serviceAccountPath = this.configService.get<string>('FCM_SERVICE_ACCOUNT_PATH');
    const serviceAccountJson = this.configService.get<string>('FCM_SERVICE_ACCOUNT_JSON');

    if (!serviceAccountPath && !serviceAccountJson) {
      errors.push('FCM not configured: Set FCM_SERVICE_ACCOUNT_PATH or FCM_SERVICE_ACCOUNT_JSON');
    }

    if (serviceAccountJson) {
      try {
        const parsed = JSON.parse(serviceAccountJson);
        if (!parsed.type || !parsed.project_id || !parsed.private_key) {
          errors.push('FCM_SERVICE_ACCOUNT_JSON is missing required fields');
        }
      } catch (error) {
        errors.push(`FCM_SERVICE_ACCOUNT_JSON is not valid JSON: ${error.message}`);
      }
    }

    if (this.initializationError) {
      errors.push(`FCM initialization failed: ${this.initializationError.message}`);
    }

    return {
      valid: errors.length === 0 && this.isConfigured(),
      errors,
    };
  }
}
