import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export enum AdminRole {
  SUPER_ADMIN = 'super_admin',
  ADMINISTRATOR = 'administrator',
  MODERATOR = 'moderator',
  SECURITY_ANALYST = 'security_analyst',
  GOVERNANCE_OPERATOR = 'governance_operator',
  AUDITOR = 'auditor',
}

export const AdminRoleHierarchy: Record<AdminRole, number> = {
  [AdminRole.SUPER_ADMIN]: 100,
  [AdminRole.ADMINISTRATOR]: 80,
  [AdminRole.SECURITY_ANALYST]: 60,
  [AdminRole.GOVERNANCE_OPERATOR]: 60,
  [AdminRole.MODERATOR]: 50,
  [AdminRole.AUDITOR]: 30,
};

@Entity('admin_users')
@Index(['walletAddress'], { unique: true })
@Index(['role'])
@Index(['isActive'])
export class Admin {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  walletAddress: string;

  @Column({ type: 'varchar', default: AdminRole.AUDITOR })
  role: AdminRole;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'json', nullable: true })
  permissions: string[] | null;

  @Column({ nullable: true })
  lastLoginAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
