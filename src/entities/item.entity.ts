import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export enum ItemType {
  XP_BOOST = 'xp_boost',
  STREAK_FREEZE = 'streak_freeze',
  COSMETIC = 'cosmetic',
}

@Entity('items')
export class Item {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column()
  description: string;

  @Column({ type: 'varchar' })
  type: ItemType;

  @Column('simple-json', { nullable: true })
  effects: Record<string, any>;

  @Column({ default: 0 })
  price: number;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
