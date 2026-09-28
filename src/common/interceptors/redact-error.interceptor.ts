import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { redactObject } from '../utils/redaction.util';

@Injectable()
export class RedactErrorInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      catchError((error) => {
        // Redact sensitive data from the error object before throwing
        const redactedError = redactObject(error);
        return throwError(() => redactedError);
      }),
    );
  }
}