import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Inject,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { Reflector } from '@nestjs/core';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import { AuditTrailService } from '../services/audit-trail.service';
import {
  AUDIT_LOG_KEY,
  AuditMetadata,
} from '../decorators/audit-log.decorator';
import {
  redactObject,
  redactSensitiveData,
} from '../../common/utils/redaction.util';

@Injectable()
export class AuditLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditLoggingInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly auditTrailService: AuditTrailService,
    @Inject(REQUEST) private readonly request: Request,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const metadata = this.reflector.get<AuditMetadata>(
      AUDIT_LOG_KEY,
      context.getHandler(),
    );

    if (!metadata) {
      return next.handle();
    }

    const args = context.getArgs();
    const entityId = this.extractEntityId(metadata.entityIdPath, args);

    if (!entityId) {
      this.logger.warn(
        `Could not extract entity ID from path: ${metadata.entityIdPath}`,
      );
      return next.handle();
    }

    let beforeState: Record<string, any> | undefined;
    if (metadata.captureBeforeState) {
      // Snapshots may contain webhook secrets; redact before they reach audit storage.
      beforeState = redactObject(this.extractState(args[0])) as Record<string, any>;
    }

    return next.handle().pipe(
      tap(async (result) => {
        try {
          let afterState: Record<string, any> | undefined;
          if (metadata.captureAfterState) {
            afterState = redactObject(this.extractState(result)) as Record<string, any>;
          }

          const userId = this.extractUserId(args);
          const walletAddress = this.extractWalletAddress(args);

          await this.auditTrailService.log({
            actionType: metadata.actionType,
            entityType: metadata.entityType,
            entityId,
            userId,
            walletAddress,
            description: metadata.descriptionTemplate
              ? redactSensitiveData(
                  this.interpolateDescription(metadata.descriptionTemplate, {
                    result,
                    args,
                  }),
                )
              : undefined,
            beforeState,
            afterState,
            metadata: {
              method: context.getClass().name,
              handler: context.getHandler().name,
            },
          });
        } catch (error) {
          this.logger.error(
            `Failed to audit log action: ${redactSensitiveData(error.message)}`,
          );
          // Don't throw - auditing should not break the application
        }
      }),
      catchError(async (error) => {
        try {
          await this.auditTrailService.log({
            actionType: metadata.actionType,
            entityType: metadata.entityType,
            entityId,
            userId: this.extractUserId(args),
            walletAddress: this.extractWalletAddress(args),
            description: `Failed: ${redactSensitiveData(error.message)}`,
            metadata: {
              method: context.getClass().name,
              handler: context.getHandler().name,
              error: redactSensitiveData(error.message),
            },
          });
        } catch (auditError) {
          this.logger.error(
            `Failed to audit log error: ${redactSensitiveData(auditError.message)}`,
          );
        }
        throw error;
      }),
    );
  }

  private extractEntityId(
    path: string | undefined,
    args: any[],
  ): string | null {
    if (!path) return null;

    try {
      const parts = path.split('.');
      let current = args;

      for (const part of parts) {
        if (part.startsWith('args[') && part.endsWith(']')) {
          const matches = part.match(/\d+/);
          if (!matches) continue;
          const index = parseInt(matches[0], 10);
          current = current[index];
        } else if (part === 'args') {
          continue;
        } else {
          current = current[part];
        }
      }

      return current?.toString() || null;
    } catch (error) {
      this.logger.warn(
        `Error extracting entity ID from path ${path}: ${error.message}`,
      );
      return null;
    }
  }

  private extractUserId(args: any[]): string | undefined {
    // Try to extract from decorated parameter
    const dto = args[0];
    if (dto?.userId) return dto.userId;

    // Try to extract from request user
    const user = (this.request as any)?.user;
    if (user?.id) return user.id;

    return undefined;
  }

  private extractWalletAddress(args: any[]): string | undefined {
    const dto = args[0];
    if (dto?.walletAddress) return dto.walletAddress;
    if (dto?.wallet) return dto.wallet;
    if (dto?.address) return dto.address;

    return undefined;
  }

  private extractState(obj: any): Record<string, any> {
    if (!obj) return {};
    if (typeof obj !== 'object') return { value: obj };

    const state: Record<string, any> = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        state[key] = obj[key];
      }
    }
    return state;
  }

  private interpolateDescription(
    template: string,
    context: Record<string, any>,
  ): string {
    return template.replace(/\${([^}]+)}/g, (match, key) => {
      return context[key]?.toString() || match;
    });
  }
}
