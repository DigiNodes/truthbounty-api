export interface BlockchainEvent<T = Record<string, any>> {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  eventType: string;
  data: T; // Flexible for different event types
}

export interface TransferEventData {
  from: string;
  to: string;
  amount: string;
  token: string;
}