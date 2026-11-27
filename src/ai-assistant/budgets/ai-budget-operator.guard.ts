import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { runtimeSchema } from '../../config/runtime-schema';
import { AiBudgetActor } from './ai-budget.types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/i;

function linkedPrincipal(principal: unknown): AiBudgetActor {
  if (!principal || typeof principal !== 'object' || Array.isArray(principal)) {
    throw new UnauthorizedException('Authenticated app user required');
  }
  const value = principal as Record<string, unknown>;
  const linked = value.user as Record<string, unknown> | null;
  if (typeof value.address !== 'string' || !value.address ||
      typeof value.userId !== 'string' || !UUID.test(value.userId) ||
      !linked || typeof linked !== 'object' || Array.isArray(linked) ||
      typeof linked.id !== 'string' || !UUID.test(linked.id) ||
      linked.id.toLowerCase() !== value.userId.toLowerCase()) {
    throw new UnauthorizedException('Authenticated app user required');
  }
  const id = value.userId.toLowerCase();
  if (typeof value.sub === 'string' && UUID.test(value.sub) &&
      value.sub.toLowerCase() !== id) {
    throw new UnauthorizedException('Authenticated app user required');
  }
  return Object.freeze({ id, role: typeof linked.role === 'string' ? linked.role : '' });
}

/** Only the canonical principal attached by JwtAuthGuard supplies ownership. */
export function getAiBudgetUserId(principal: unknown): string {
  return linkedPrincipal(principal).id;
}

/** App role comes from the verified linked user, never top-level/body role fields. */
export function getAiBudgetActor(principal: unknown): AiBudgetActor {
  return linkedPrincipal(principal);
}

/** Shared by the operator guard and every server-only administrative service API. */
export function assertAiBudgetOperator(actor: AiBudgetActor, config: ConfigService): AiBudgetActor {
  const denied = () => new ForbiddenException('AI budget administration is not permitted');
  if (!actor || typeof actor.id !== 'string' || !UUID.test(actor.id) || actor.role !== 'admin') {
    throw denied();
  }
  let ids: readonly string[];
  try {
    const configured = config.get<unknown>('AI_BUDGET_OPERATOR_IDS');
    if (configured !== undefined && typeof configured !== 'string') throw denied();
    ids = runtimeSchema.AI_BUDGET_OPERATOR_IDS.parse(
      configured === undefined ? '' : configured as string,
    );
  } catch {
    throw denied();
  }
  const id = actor.id.toLowerCase();
  if (!ids.includes(id)) throw denied();
  return Object.freeze({ id, role: 'admin' });
}

@Injectable()
export class AiBudgetOperatorGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: unknown }>();
    assertAiBudgetOperator(getAiBudgetActor(request.user), this.config);
    return true;
  }
}
