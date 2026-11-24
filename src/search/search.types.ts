export type SearchableEntity = 'claims' | 'disputes' | 'users';

export enum SortField {
  NEWEST = 'newest',
  OLDEST = 'oldest',
  RELEVANCE = 'relevance',
  REPUTATION = 'reputation',
  REWARD = 'reward',
}

export enum PaginationType {
  OFFSET = 'offset',
  CURSOR = 'cursor',
}

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
  nextCursor?: string;
}

export interface PublicUserResult {
  id: string;
  walletAddress: string;
  reputation: number;
  worldcoinVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface GlobalSearchResult {
  query: string;
  claims: SearchResult<unknown>;
  disputes: SearchResult<unknown>;
  users: SearchResult<PublicUserResult>;
}
