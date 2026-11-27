import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AiBudgetOperatorGuard,
  assertAiBudgetOperator,
  getAiBudgetActor,
  getAiBudgetUserId,
} from './ai-budget-operator.guard';

const operatorId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const principal = (role = 'admin') => ({
  userId: operatorId,
  address: '0x1111111111111111111111111111111111111111',
  user: { id: operatorId, role },
});
const context = (request: Record<string, unknown>) =>
  ({
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;
const guard = (ids: unknown = operatorId) =>
  new AiBudgetOperatorGuard(new ConfigService({ AI_BUDGET_OPERATOR_IDS: ids }));

describe('AI budget operator authority', () => {
  it('requires a linked verified app admin and the server operator grant', () => {
    expect(guard().canActivate(context({ user: principal() }))).toBe(true);
    expect(getAiBudgetActor(principal())).toEqual({ id: operatorId, role: 'admin' });
  });

  it.each([undefined, null, {}, []])('denies a missing principal %j despite body authority', (user) => {
    expect(() => guard().canActivate(context({
      user,
      body: { actorId: operatorId, role: 'admin', capability: 'ai_budget.override.create' },
    }))).toThrow(UnauthorizedException);
  });

  it('does not accept the legacy request.use alias as authenticated authority', () => {
    expect(() => guard().canActivate(context({ use: principal() })))
      .toThrow(UnauthorizedException);
  });

  it.each(['contributor', 'moderator', 'ADMIN', 'super_admin', ''])(
    'rejects app role %j even for an allowlisted identity',
    (role) => {
      expect(() => guard().canActivate(context({ user: principal(role) })))
        .toThrow(ForbiddenException);
    },
  );

  it('ignores a forged top-level admin role', () => {
    expect(() => guard().canActivate(context({
      user: { ...principal('contributor'), role: 'admin' },
    }))).toThrow(ForbiddenException);
  });

  it('rejects mismatched canonical and linked-user identifiers', () => {
    expect(() => guard().canActivate(context({
      user: { ...principal(), user: { id: otherId, role: 'admin' } },
    }))).toThrow(UnauthorizedException);
  });

  it('rejects a conflicting UUID token subject', () => {
    expect(() => getAiBudgetUserId({ ...principal(), sub: otherId }))
      .toThrow(UnauthorizedException);
  });

  it('accepts a wallet subject without treating it as a user identifier', () => {
    expect(getAiBudgetUserId({ ...principal(), sub: principal().address }))
      .toBe(operatorId);
  });

  it('requires a linked app user instead of trusting a lone token userId', () => {
    expect(() => getAiBudgetUserId({ ...principal(), user: null }))
      .toThrow(UnauthorizedException);
  });

  it('rejects an unlisted verified admin', () => {
    expect(() => guard(otherId).canActivate(context({ user: principal() })))
      .toThrow(ForbiddenException);
  });

  it.each([undefined, '', ' ', 'not-a-uuid', operatorId + ',', [operatorId]])(
    'fails closed for an empty or invalid runtime allowlist %j',
    (ids) => {
      const denied = new AiBudgetOperatorGuard(
        new ConfigService(ids === undefined ? {} : { AI_BUDGET_OPERATOR_IDS: ids }),
      );
      expect(() => denied.canActivate(context({ user: principal() })))
        .toThrow(ForbiddenException);
    },
  );

  it('normalizes UUID case and whitespace through the runtime schema', () => {
    const id = 'abcdefab-cdef-4abc-8abc-abcdefabcdef';
    const user = { ...principal(), userId: id, user: { id, role: 'admin' } };
    expect(guard(' ' + id.toUpperCase() + ' ').canActivate(context({ user })))
      .toBe(true);
  });

  it('rejects duplicate allowlist UUIDs differing only in case', () => {
    const id = 'abcdefab-cdef-4abc-8abc-abcdefabcdef';
    expect(() => guard(id + ',' + id.toUpperCase()).canActivate(context({ user: principal() })))
      .toThrow(ForbiddenException);
  });

  it('rechecks the same grant at the server-only service boundary', () => {
    expect(() => assertAiBudgetOperator(
      { id: operatorId, role: 'contributor' },
      new ConfigService({ AI_BUDGET_OPERATOR_IDS: operatorId }),
    )).toThrow(ForbiddenException);
    expect(() => assertAiBudgetOperator(
      { id: otherId, role: 'admin' },
      new ConfigService({ AI_BUDGET_OPERATOR_IDS: operatorId }),
    )).toThrow(ForbiddenException);
  });

  it('returns an immutable actor copy', () => {
    const user = principal();
    const actor = getAiBudgetActor(user);
    user.user.role = 'contributor';
    expect(actor.role).toBe('admin');
    expect(Object.isFrozen(actor)).toBe(true);
  });
});
