export type SearchableEntity = 'claims' | 'disputes' | 'users';

export type SortField = 'newest' | 'oldest' | 'relevance' | 'reputation' | 'reward';

export type PaginationType = 'offset' | 'cursor';

export interface SearchFilter {
  status?: string;
  owner?: string;
  walletAddress?: string;
  fromDate?: string;
  toDate?: string;
  finalized?: boolean;
}

export interface PaginationParams {
  page: number;
  limit: number;
  type: PaginationType;
  cursor?: string;
}

export interface SearchResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface GlobalSearchResult {
  query: string;
  claims: SearchResult<unknown>;
  disputes: SearchResult<unknown>;
  users: SearchResult<unknown>;
}
