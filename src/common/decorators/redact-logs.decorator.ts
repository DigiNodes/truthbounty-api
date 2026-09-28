import { SetMetadata } from '@nestjs/common';

export const REDACT_LOGS_KEY = 'REDACT_LOGS';

export const RedactLogs = () => SetMetadata(REDACT_LOGS_KEY, true);