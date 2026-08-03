import { Repository, EntityManager, FindOptionsWhere, FindManyOptions } from 'typeorm';

/**
 * BaseRepository — generic repository base class providing common CRUD
 * operations and transaction-scoped repository access.
 *
 * All domain repositories (UserRepository, BountyRepository, etc.) should
 * extend this class to inherit consistent data-access patterns.
 *
 * ## Usage
 *
 * ```ts
 * @Injectable()
 * class UserRepository extends BaseRepository<UserEntity> {
 *   constructor(
 *     @InjectDataSource() dataSource: DataSource,
 *   ) {
 *     super(dataSource, UserEntity);
 *   }
 *
 *   async findByEmail(email: string): Promise<UserEntity | null> {
 *     return this.findOne({ where: { email } });
 *   }
 * }
 * ```
 *
 * ## Transaction support
 *
 * Use `withManager(manager)` to obtain a repository instance bound to
 * a specific {@link EntityManager} (e.g., inside a {@link TransactionRunner}
 * callback). All operations on the returned proxy are scoped to the
 * transaction.
 *
 * ```ts
 * await tx.run(async (manager) => {
 *   const repo = userRepo.withManager(manager);
 *   await repo.update(userId, { status: 'active' });
 * });
 * ```
 */
export class BaseRepository<T extends object> {
  protected readonly repo: Repository<T>;

  constructor(
    private readonly dataSourceOrManager: { getRepository: (target: new () => T) => Repository<T> },
    private readonly entityClass: new () => T,
  ) {
    this.repo = dataSourceOrManager.getRepository(entityClass);
  }

  /**
   * Returns a repository instance bound to the given {@link EntityManager}.
   * Use this inside transactions to ensure all queries participate in the
   * same atomic boundary.
   */
  withManager(manager: EntityManager): this {
    const Ctor = this.constructor as new (...args: any[]) => this;
    return new Ctor(manager, this.entityClass);
  }

  // ── Read ──────────────────────────────────────────────────────────

  async findAll(options?: FindManyOptions<T>): Promise<T[]> {
    return this.repo.find(options);
  }

  async findById(id: string | number): Promise<T | null> {
    return this.repo.findOneBy({ id } as unknown as FindOptionsWhere<T>);
  }

  async findOne(where: FindOptionsWhere<T>): Promise<T | null> {
    return this.repo.findOneBy(where);
  }

  async findMany(where: FindOptionsWhere<T>): Promise<T[]> {
    return this.repo.findBy(where);
  }

  async count(where?: FindOptionsWhere<T>): Promise<number> {
    return this.repo.countBy(where ?? ({} as FindOptionsWhere<T>));
  }

  // ── Write ─────────────────────────────────────────────────────────

  async create(entity: T): Promise<T> {
    return this.repo.save(entity);
  }

  async createMany(entities: T[]): Promise<T[]> {
    return this.repo.save(entities);
  }

  async update(
    id: string | number,
    partial: Partial<T>,
  ): Promise<T | null> {
    await this.repo.update(id as any, partial as any);
    return this.findById(id);
  }

  async delete(id: string | number): Promise<boolean> {
    const result = await this.repo.delete(id as any);
    return (result.affected ?? 0) > 0;
  }
}
