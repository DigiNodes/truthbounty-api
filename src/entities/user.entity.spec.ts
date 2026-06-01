import 'reflect-metadata';
import { getMetadataArgsStorage } from 'typeorm';
import { User } from './user.entity';
import { UserEntity } from '../modules/users/entities/user.entity';

describe('User entity schema sync (BE-203)', () => {
  it('canonical User entity and re-exported UserEntity should reference the same class', () => {
    expect(UserEntity).toBe(User);
  });

  it('User entity maps to the "users" table', () => {
    const tableMetadata = getMetadataArgsStorage().tables.find(
      (t) => t.target === User,
    );
    expect(tableMetadata?.name).toBe('users');
  });

  describe('field coverage — TypeORM ↔ Prisma sync', () => {
    let columnNames: string[];

    beforeAll(() => {
      columnNames = getMetadataArgsStorage()
        .columns.filter((c) => c.target === User)
        .map((c) => c.propertyName as string);
    });

    // Fields that must exist in both TypeORM entity and Prisma User model
    const requiredFields = [
      'id',
      'walletAddress',
      'reputation',
      'worldcoinVerified',
      'worldcoinVerifiedAt',
      'createdAt',
      'updatedAt',
    ];

    for (const field of requiredFields) {
      it(`should declare column "${field}"`, () => {
        expect(columnNames).toContain(field);
      });
    }

    it('walletAddress should be marked unique', () => {
      const col = getMetadataArgsStorage().columns.find(
        (c) => c.target === User && c.propertyName === 'walletAddress',
      );
      expect(col?.options?.unique).toBe(true);
    });

    it('worldcoinVerified should default to false', () => {
      const col = getMetadataArgsStorage().columns.find(
        (c) => c.target === User && c.propertyName === 'worldcoinVerified',
      );
      expect(col?.options?.default).toBe(false);
    });

    it('worldcoinVerifiedAt should be nullable', () => {
      const col = getMetadataArgsStorage().columns.find(
        (c) => c.target === User && c.propertyName === 'worldcoinVerifiedAt',
      );
      expect(col?.options?.nullable).toBe(true);
    });

    it('reputation should default to 0', () => {
      const col = getMetadataArgsStorage().columns.find(
        (c) => c.target === User && c.propertyName === 'reputation',
      );
      expect(col?.options?.default).toBe(0);
    });
  });

  describe('relation coverage', () => {
    it('User entity has a wallets OneToMany relation', () => {
      const relations = getMetadataArgsStorage().relations.filter(
        (r) => r.target === User,
      );
      const walletsRelation = relations.find((r) => r.propertyName === 'wallets');
      expect(walletsRelation).toBeDefined();
      expect(walletsRelation?.relationType).toBe('one-to-many');
    });
  });
});
