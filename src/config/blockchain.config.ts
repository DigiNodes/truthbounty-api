import { registerAs } from '@nestjs/config';

export default registerAs('blockchain', () => ({
  rpcUrl:
    process.env.BLOCKCHAIN_RPC_URL || 'https://mainnet.infura.io/v3/YOUR_KEY',
  contractAddress: process.env.REWARD_CONTRACT_ADDRESS,
  startBlock: parseInt(process.env.START_BLOCK || '0', 10),
  confirmations: parseInt(process.env.REQUIRED_CONFIRMATIONS || '12', 10),
}));
