import { Column, Entity, Index, PrimaryGeneratedColumn, CreateDateColumn, OneToMany } from 'typeorm';
import { Evidence } from './evidence.entity';

/**
 * Claim state machine states
 */
export enum ClaimState {
  PENDING = 'PENDING',     // Initial state: no verdict yet
  RESOLVED = 'RESOLVED',   // Verdict assigned but not finalized
  FINALIZED = 'FINALIZED', // Terminal state: verdict is final
}

/**
 * Data required for state transitions
 */
export interface ClaimTransitionData {
  verdict?: boolean;
  confidence?: number;
}

@Entity('claims')
@Index(['finalized'])
@Index(['confidenceScore'])
@Index(['resolvedVerdict'])
export class Claim {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({ type: 'varchar', length: 5000 })
  content: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  source: string | null;

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any> | null;

  @Column({ type: 'boolean', nullable: true })
  resolvedVerdict: boolean | null;

  @Column({
    type: 'decimal',
    precision: 5,
    scale: 4,
    nullable: true,
  })
  confidenceScore: number | null;

  @Column({ default: false })
  finalized: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  resolvedAt: Date | null;

  @OneToMany(() => Evidence, (evidence) => evidence.claim, { cascade: true })
  evidences: Evidence[];

  /**
   * Get the current state of the claim based on its fields
   */
  getCurrentState(): ClaimState {
    if (this.finalized) {
      return ClaimState.FINALIZED;
    }
    if (this.resolvedVerdict !== null && this.confidenceScore !== null) {
      return ClaimState.RESOLVED;
    }
    return ClaimState.PENDING;
  }

  /**
   * Validate and perform state transition with proper checks
   * Prevents invalid state transitions and ensures data integrity
   * 
   * Valid transitions:
   * - PENDING → RESOLVED (requires verdict + confidence)
   * - PENDING → FINALIZED (requires verdict + confidence)
   * - RESOLVED → FINALIZED (no additional data required)
   * 
   * Invalid transitions:
   * - FINALIZED → * (finalized claims are immutable)
   * - RESOLVED → PENDING (cannot unresolve)
   * 
   * @param targetState - The desired state to transition to
   * @param data - Optional data required for the transition (verdict, confidence)
   * @throws Error if transition is invalid or required data is missing
   */
  transitionTo(targetState: ClaimState, data?: ClaimTransitionData): void {
    const currentState = this.getCurrentState();

    // Prevent any transitions from FINALIZED state (immutable)
    if (currentState === ClaimState.FINALIZED) {
      throw new Error(
        `Invalid transition: Cannot transition from FINALIZED state. Claim ${this.id} is immutable.`
      );
    }

    // Validate transition based on current and target states
    switch (targetState) {
      case ClaimState.PENDING:
        // Cannot transition back to PENDING from any state
        throw new Error(
          `Invalid transition: Cannot transition to PENDING from ${currentState}. Claims cannot be unresolved.`
        );

      case ClaimState.RESOLVED:
        if (currentState === ClaimState.PENDING) {
          // PENDING → RESOLVED: requires verdict and confidence
          if (data?.verdict === undefined || data?.confidence === undefined) {
            throw new Error(
              'Invalid transition: PENDING → RESOLVED requires both verdict and confidence data.'
            );
          }
          this.resolvedVerdict = data.verdict;
          this.confidenceScore = data.confidence;
          this.finalized = false;
        } else if (currentState === ClaimState.RESOLVED) {
          // RESOLVED → RESOLVED: allow updating verdict/confidence
          if (data?.verdict !== undefined) {
            this.resolvedVerdict = data.verdict;
          }
          if (data?.confidence !== undefined) {
            this.confidenceScore = data.confidence;
          }
        }
        break;

      case ClaimState.FINALIZED:
        if (currentState === ClaimState.PENDING) {
          // PENDING → FINALIZED: requires verdict and confidence
          if (data?.verdict === undefined || data?.confidence === undefined) {
            throw new Error(
              'Invalid transition: PENDING → FINALIZED requires both verdict and confidence data.'
            );
          }
          this.resolvedVerdict = data.verdict;
          this.confidenceScore = data.confidence;
          this.finalized = true;
        } else if (currentState === ClaimState.RESOLVED) {
          // RESOLVED → FINALIZED: just set finalized flag
          // Optionally update verdict/confidence if provided
          if (data?.verdict !== undefined) {
            this.resolvedVerdict = data.verdict;
          }
          if (data?.confidence !== undefined) {
            this.confidenceScore = data.confidence;
          }
          this.finalized = true;
        }
        break;

      default:
        throw new Error(`Invalid target state: ${targetState}`);
    }
  }
}

