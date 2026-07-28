import { Controller, Get, Param, Query, ValidationPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SearchService } from './search.service';
import { SearchQueryDto } from './dto/search-query.dto';
import {
  GlobalSearchResult,
  PaginationParams,
  PaginationType,
  SearchableEntity,
  SearchFilter,
  SearchResult,
  SortField,
} from './search.types';

@ApiTags('Search')
@Controller('search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  @Get()
  @ApiOperation({ summary: 'Global search across claims, disputes, and users' })
  async globalSearch(
    @Query(new ValidationPipe({ transform: true, whitelist: true }))
    query: SearchQueryDto,
  ): Promise<GlobalSearchResult> {
    const { q = '', ...filters } = query;
    return this.searchService.searchGlobal(
      q,
      this.buildFilters(filters),
      this.buildPagination(filters),
      (filters.sort as SortField) ?? SortField.NEWEST,
    );
  }

  @Get(':entity')
  @ApiOperation({ summary: 'Entity-specific search' })
  async entitySearch(
    @Param('entity') entity: SearchableEntity,
    @Query(new ValidationPipe({ transform: true, whitelist: true }))
    query: SearchQueryDto,
  ): Promise<SearchResult<unknown>> {
    const { q = '', ...filters } = query;
    return this.searchService.searchEntity(
      entity,
      q,
      this.buildFilters(filters),
      this.buildPagination(filters),
      (filters.sort as SortField) ?? SortField.NEWEST,
    );
  }

  private buildFilters(dto: Omit<SearchQueryDto, 'q'>): SearchFilter {
    return {
      status: dto.status,
      owner: dto.owner,
      walletAddress: dto.walletAddress,
      fromDate: dto.fromDate,
      toDate: dto.toDate,
      finalized: dto.finalized,
    };
  }

  private buildPagination(dto: Omit<SearchQueryDto, 'q'>): PaginationParams {
    return {
      page: dto.page ?? 1,
      limit: dto.limit ?? 20,
      type: (dto.pagination as PaginationType) ?? PaginationType.OFFSET,
      cursor: dto.cursor,
    };
  }
}
