import { Injectable } from '@nestjs/common';
import { Claim } from './entities/claim.entity';
import { CreateClaimDTO as CreateClaimDto } from './dto/create-claim.dto';
import { rejectLegacyProtocolOperation } from './protocol-authority';

@Injectable()
export class ClaimsService {
  async findOne(_id: string): Promise<Claim | null> {
    return rejectLegacyProtocolOperation(
      'Legacy claim rows are not canonical. Query the V2 claim read model.',
    );
  }

  async findLatest(_limit = 10): Promise<Claim[]> {
    return rejectLegacyProtocolOperation(
      'Legacy claim rows are not canonical. Query the V2 claim read model.',
    );
  }

  async findByUser(_wallet: string): Promise<Claim[]> {
    return rejectLegacyProtocolOperation(
      'Legacy wallet claim rows are not canonical. Query the V2 claim read model.',
    );
  }

  async paginateClaims(
    _filters: unknown,
    _sort: unknown,
    _cursor?: string,
    _pageSize?: number,
  ): Promise<never> {
    return rejectLegacyProtocolOperation(
      'Legacy claim rows are not canonical. Query the V2 claim read model.',
    );
  }

  async createClaim(_input: CreateClaimDto): Promise<Claim> {
    return rejectLegacyProtocolOperation(
      'The API cannot create claims. Submit the transaction from the user wallet and wait for its finalized claim read model.',
    );
  }

  async resolveClaim(
    _claimId: string,
    _verdict: boolean,
    _confidenceScore: number,
    _userId?: string,
  ): Promise<Claim> {
    return rejectLegacyProtocolOperation(
      'The API cannot resolve claims. Claim outcomes are read only from canonical protocol events.',
    );
  }

  async finalizeClaim(_claimId: string, _userId?: string): Promise<Claim> {
    return rejectLegacyProtocolOperation(
      'The API cannot finalize claims. Finality is derived only from canonical protocol events.',
    );
  }
}
