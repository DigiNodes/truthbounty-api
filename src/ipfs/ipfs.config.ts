import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface IpfsConfig {
  provider: 'local';
  localStoragePath: string;
}

@Injectable()
export class IpfsConfigService {
  constructor(private configService: ConfigService) {}

  getConfig(): IpfsConfig {
    const provider = this.configService.get<string>('IPFS_PROVIDER', 'local');
    if (provider !== 'local') {
      throw new Error(`Unsupported IPFS provider: ${provider}`);
    }
    return {
      provider,
      localStoragePath: this.configService.get(
        'IPFS_LOCAL_STORAGE_PATH',
        'data/ipfs',
      ),
    };
  }
}
