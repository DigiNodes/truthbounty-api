export interface BlockchainEvent {
  txHash: string;
  logIndex: number;
  blockNumber: number;
  eventType: string;
  data: any; // Flexible for different event types
}

export interface TransferEventData {
  from: string;
  to: string;
  amount: string;
  token: string;
}