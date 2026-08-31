import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum DisputeStatus {
  RAISED = 'raised',
  RESOLVED = 'resolved',
  EXPIRED = 'expired',
}

/**
 * One dispute over a verification round's provisional outcome.
 *
 * disputeId is derived deterministically as `${claimId}:${originalRoundId}`
 * rather than taken from an assumed event field, so it is always
 * reconstructable from the DisputeRaised event alone and there is exactly
 * one dispute per round-outcome-challenged, matching the AC that a dispute
 * links deterministically to its original claim and provisional outcome.
 *
 * Explicit terminal statuses (resolved/expired) live on this row.
 * Rejected/invalid *transitions* (e.g. resolving an already-resolved
 * dispute, or one that was never raised) are represented separately in
 * v2_indexing_anomalies -- see disputes-projector.service.ts -- rather than
 * as a status value here, since they describe a replay event, not an
 * outcome of the dispute itself.
 */
@Entity('v2_project_dispute')
@Index(['claimId'])
export class ProjectDispute {
  @PrimaryColumn({ type: 'varchar', length: 200 })
  disputeId: string;

  @Column({ type: 'varchar', length: 66 })
  claimId: string;

  @Column({ type: 'varchar', length: 66 })
  originalRoundId: string;

  /**
   * The appeal round this dispute opened, when known. Flagged assumption:
   * populated from the DisputeRaised payload's `appealRoundId` field, if
   * present, since no frozen ABI exists yet to confirm how (or whether) the
   * protocol correlates a dispute to its appeal round.
   */
  @Column({ type: 'varchar', length: 66, nullable: true })
  appealRoundId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  challengeBond: string | null;

  @Column({ type: 'varchar', length: 42, nullable: true })
  challengeBondAsset: string | null;

  @Column({ type: 'varchar', length: 16, default: DisputeStatus.RAISED })
  status: DisputeStatus;

  @Column({ type: Date, nullable: true })
  deadline: Date | null;

  /** Verbatim final outcome from DisputeResolved, not recomputed by the API. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  resolvedOutcome: string | null;

  @Column({ type: 'varchar', length: 66 })
  eventTxHash: string;

  @Column({ type: 'int' })
  eventLogIndex: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
