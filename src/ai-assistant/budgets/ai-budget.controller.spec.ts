import 'reflect-metadata';
import { BadRequestException, RequestMethod, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { EXCEPTION_FILTERS_METADATA, GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { AI_BUDGET_AUTHORIZATION_MATRIX } from '../../auth/authorization-matrix';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import { AiBudgetService } from './ai-budget.service';
import { AiBudgetAdminService } from './ai-budget-admin.service';
import { AiBudgetController } from './ai-budget.controller';
import { AiBudgetExceptionFilter } from './ai-budget-exception.filter';
import {
  AiBudgetChangeReferenceDto,
  AiBudgetOverrideDto,
  AiBudgetPolicyDto,
  AiBudgetPriceDto,
} from './ai-budget.dto';
import { AiBudgetOperatorGuard } from './ai-budget-operator.guard';

const userId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const principal = {
  userId,
  address: '0x1111111111111111111111111111111111111111',
  user: { id: userId, role: 'admin' },
};
const price = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  inputNanos: '150',
  outputNanos: '600',
  cachedInputNanos: '75',
  changeReference: 'OPS-818',
};
const override = {
  userId: otherId,
  window: 'day',
  extraTokens: '1000',
  extraSpendUsdNanos: '1000000000',
  expiresAt: '2026-11-21T23:00:00.000Z',
  changeReference: 'OPS-818',
};
const pipe = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
  forbidUnknownValues: true,
  disableErrorMessages: true,
});

describe('AI budget transport boundary', () => {
  const budget = { getUserUsage: jest.fn() };
  const admin = {
    createPrice: jest.fn(),
    activatePolicy: jest.fn(),
    beginCoverage: jest.fn(),
    createOverride: jest.fn(),
    revokeOverride: jest.fn(),
  };
  const controller = new AiBudgetController(
    budget as unknown as AiBudgetService,
    admin as unknown as AiBudgetAdminService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('reads only the current authenticated user and preserves the user-only response', async () => {
    const usage = { windows: [{
      window: 'day', startAt: '2026-11-21T00:00:00.000Z',
      resetAt: '2026-11-22T00:00:00.000Z', actualTokens: '10',
      chargedTokens: '20', chargedSpendUsdNanos: null, uncertainRequests: 1,
    }] };
    budget.getUserUsage.mockResolvedValue(usage);
    await expect(controller.me(principal)).resolves.toEqual(usage);
    expect(budget.getUserUsage).toHaveBeenCalledWith(userId);
    expect(Object.keys(usage)).toEqual(['windows']);
  });

  it('refuses a mismatched current-user identity before reading usage', async () => {
    await expect(controller.me({
      ...principal, user: { id: otherId, role: 'admin' },
    })).rejects.toThrow(UnauthorizedException);
    expect(budget.getUserUsage).not.toHaveBeenCalled();
  });

  it('derives the admin actor only from the verified linked principal', async () => {
    admin.createPrice.mockResolvedValue({ id: otherId });
    await controller.createPrice(principal, price as AiBudgetPriceDto);
    expect(admin.createPrice).toHaveBeenCalledWith(
      { id: userId, role: 'admin' }, price,
    );
  });

  it('passes only the authenticated actor to every administrative operation', async () => {
    await controller.activatePolicy(principal, { rules: [], changeReference: 'OPS-818' });
    await controller.beginCoverage(principal, { changeReference: 'OPS-818' });
    await controller.createOverride(principal, override as AiBudgetOverrideDto);
    await controller.revokeOverride(principal, otherId, { changeReference: 'OPS-818' });
    for (const operation of [admin.activatePolicy, admin.beginCoverage, admin.createOverride, admin.revokeOverride]) {
      expect(operation.mock.calls[0][0]).toEqual({ id: userId, role: 'admin' });
    }
    expect(admin.revokeOverride).toHaveBeenCalledWith(
      { id: userId, role: 'admin' }, otherId, { changeReference: 'OPS-818' },
    );
  });

  it.each(['actorId', 'role', 'capability', 'unlimited', 'reason', 'prompt'])(
    'rejects body authority or free-form field %s',
    async (field) => {
      await expect(pipe.transform(
        { ...price, [field]: 'secret-prompt-canary' },
        { type: 'body', metatype: AiBudgetPriceDto },
      )).rejects.toThrow(BadRequestException);
    },
  );

  it.each([
    ['01', '10'], ['-1', '10'], ['1e6', '10'], ['1.5', '10'], ['1\n', '10'],
    [1, '10'], ['1', '001'], ['1', '-1'],
  ])('refuses noncanonical token/spend amounts %j / %j', async (extraTokens, extraSpendUsdNanos) => {
    await expect(pipe.transform(
      { ...override, extraTokens, extraSpendUsdNanos },
      { type: 'body', metatype: AiBudgetOverrideDto },
    )).rejects.toThrow(BadRequestException);
  });

  it.each(['*', 'global', 'openai', 'not-a-uuid'])('refuses override subject %j', async (id) => {
    await expect(pipe.transform(
      { ...override, userId: id },
      { type: 'body', metatype: AiBudgetOverrideDto },
    )).rejects.toThrow(BadRequestException);
  });

  it.each(['2026-11-21T15:00:00', '2026-11-22', '2026-02-31T15:00:00.000Z'])(
    'requires an unambiguous valid expiry timestamp %j',
    async (expiresAt) => {
      await expect(pipe.transform(
        { ...override, expiresAt },
        { type: 'body', metatype: AiBudgetOverrideDto },
      )).rejects.toThrow(BadRequestException);
    },
  );

  it('validates nested policy DTOs and rejects nested authority fields', async () => {
    await expect(pipe.transform({
      rules: [{ scope: 'user', subject: '*', window: 'day',
        tokenLimit: '1000', spendLimitUsdNanos: '10000', bypass: true }],
      changeReference: 'OPS-818',
    }, { type: 'body', metatype: AiBudgetPolicyDto })).rejects.toThrow(BadRequestException);
  });

  it('refuses client baseline tokens or coverage timestamps', async () => {
    for (const extra of [{ coverageStart: '2000-01-01T00:00:00Z' }, { baselineTokens: '0' }]) {
      await expect(pipe.transform(
        { changeReference: 'OPS-818', ...extra },
        { type: 'body', metatype: AiBudgetChangeReferenceDto },
      )).rejects.toThrow(BadRequestException);
    }
  });

  it.each(['prompt text', 'OPS-0', 'OPS-818\nsecret', 'ops-818', 'OPS-000818', 'OPS-818\n'])(
    'refuses a nonopaque change reference %j',
    async (changeReference) => {
      await expect(pipe.transform({ changeReference },
        { type: 'body', metatype: AiBudgetChangeReferenceDto }))
        .rejects.toThrow(BadRequestException);
    },
  );

  it('matches the canonical guarded route matrix', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AiBudgetController)).toBe('ai/budgets');
    expect(Reflect.getMetadata(GUARDS_METADATA, AiBudgetController)).toEqual([JwtAuthGuard]);
    expect(Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, AiBudgetController)).toEqual([AiBudgetExceptionFilter]);
    expect(AI_BUDGET_AUTHORIZATION_MATRIX.map((route) => route.path)).toEqual([
      '/ai/budgets/me', '/ai/budgets/admin/prices', '/ai/budgets/admin/policies',
      '/ai/budgets/admin/coverage', '/ai/budgets/admin/overrides',
      '/ai/budgets/admin/overrides/:id/revoke',
    ]);
    expect(Reflect.getMetadata(PATH_METADATA, AiBudgetController.prototype.me)).toBe('me');
    const handlers = [
      AiBudgetController.prototype.me,
      AiBudgetController.prototype.createPrice, AiBudgetController.prototype.activatePolicy,
      AiBudgetController.prototype.beginCoverage, AiBudgetController.prototype.createOverride,
      AiBudgetController.prototype.revokeOverride,
    ];
    expect(handlers.map((handler) => ({
      method: Reflect.getMetadata(METHOD_METADATA, handler),
      path: '/ai/budgets/' + Reflect.getMetadata(PATH_METADATA, handler),
    }))).toEqual(AI_BUDGET_AUTHORIZATION_MATRIX.map((route) => ({
      method: RequestMethod[route.method], path: route.path,
    })));
    for (const handler of handlers.slice(1)) {
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([RolesGuard, AiBudgetOperatorGuard]);
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual(['admin']);
    }
    expect(AI_BUDGET_AUTHORIZATION_MATRIX[0].owner).toBe('current-user');
    expect(AI_BUDGET_AUTHORIZATION_MATRIX.slice(1).every(
      (route) => route.operatorAllowlist === 'AI_BUDGET_OPERATOR_IDS' && route.appRole === 'admin',
    )).toBe(true);
  });
});
