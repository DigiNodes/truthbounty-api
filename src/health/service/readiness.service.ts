import { Injectable } from '@nestjs/common';

@Injectable()
export class ReadinessService {
  async check() {
    const dependencies = [
      {
        name: 'PostgreSQL',
        status: await this.checkDatabase(),
      },
      {
        name: 'Redis',
        status: await this.checkRedis(),
      },
      {
        name: 'Ethereum RPC',
        status: await this.checkEthereumRpc(),
      },
    ];

    const ready = dependencies.every(
      dep => dep.status === 'Healthy',
    );

    return {
      status: ready ? 'READY' : 'NOT_READY',
      timestamp: new Date().toISOString(),
      dependencies,
    };
  }

  private async checkDatabase() {
    return 'Healthy';
  }

  private async checkRedis() {
    return 'Healthy';
  }

  private async checkEthereumRpc() {
    return 'Healthy';
  }
}