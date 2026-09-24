export interface AnalyticsResponse<T> {
  data: T;
  metadata: {
    generatedAt: string;
    requestIdentifier: string;
    filtersApplied: Record<string, any>;
    processingTimeMs: number;
    cached: boolean;
  };
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
