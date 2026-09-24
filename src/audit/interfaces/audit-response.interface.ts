import { AuditLog } from '../entities/audit-log.entity';

export interface AuditResponse<T = AuditLog> {
  success: boolean;
  data: T;
  timestamp: string;
  requestId?: string;
}

export interface AuditPaginatedResponse<T = AuditLog> {
  success: boolean;
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrevious: boolean;
  };
  timestamp: string;
  requestId?: string;
}

export interface AuditErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: any;
  };
  timestamp: string;
  requestId?: string;
}

export interface ComplianceReport {
  id: string;
  type: string;
  title: string;
  generatedAt: string;
  generatedBy: string;
  dateRange: {
    start: string;
    end: string;
  };
  summary: Record<string, number>;
  records: any[];
  totalRecords: number;
}

export interface SecurityIncident {
  id: string;
  type: string;
  severity: string;
  description: string;
  timestamp: string;
  actor: string;
  ipAddress?: string;
  metadata?: Record<string, any>;
  resolved: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
}
