import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface IpfsConfig {
  provider: string;
  localStoragePath: string;
}

@Injectable()
export class IpfsConfigService {
  constructor(private configService: ConfigService) {}

  getConfig(): IpfsConfig {
    return {
      provider: this.configService.get('IPFS_PROVIDER', 'local'),
      localStoragePath: this.configService.get(
        'IPFS_LOCAL_STORAGE_PATH',
        'data/ipfs',
      ),
    };
  }
}
