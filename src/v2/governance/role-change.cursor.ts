import { getRuntimeEnvironment } from '../../config/runtime-config';
import {
  CursorBindingInput,
  CursorInvalidException,
  CursorReleaseContext,
  CursorService,
  resolveCursorServiceOptionsFromEnv,
} from '../../common/pagination/cursor.service';

export const ROLE_CHANGE_CURSOR_ROUTE = 'v2:governance:role-changes';
export const ROLE_CHANGE_CURSOR_SCHEMA_VERSION = 1;
export const ROLE_CHANGE_CURSOR_SORT =
  'blockNumber:DESC,logIndex:DESC,txHash:DESC';

const ZERO_CHECKSUM = '0'.repeat(64);
const UNPINNED_RELEASE = 'unpinned';

export interface RoleChangeOrderKey {
  blockNumber: string;
  logIndex: number;
  txHash: string;
}

export interface RoleChangeCursorScope {
  chainId: number;
  account?: string | null;
  role?: string | null;
}

export type RoleChangeReleaseResolver = () => CursorReleaseContext;
export type RoleChangeCursorFactory = () => CursorService;

export const ROLE_CHANGE_CURSOR_FACTORY = Symbol('ROLE_CHANGE_CURSOR_FACTORY');
export const ROLE_CHANGE_CURSOR_RELEASE = Symbol('ROLE_CHANGE_CURSOR_RELEASE');

export function defaultRoleChangeCursorFactory(): CursorService {
  return new CursorService(resolveCursorServiceOptionsFromEnv());
}

export function defaultRoleChangeReleaseResolver(): CursorReleaseContext {
  const env = getRuntimeEnvironment();
  return {
    chainId: String(env.CHAIN_ID ?? env.BLOCKCHAIN_CHAIN_ID ?? '10'),
    releaseId:
      env.INDEXER_RELEASE_ID ?? env.CONTRACT_RELEASE_ID ?? UNPINNED_RELEASE,
    deploymentBlock: Number(
      env.INDEXER_DEPLOYMENT_BLOCK ??
        env.CONTRACT_RELEASE_DEPLOYMENT_BLOCK ??
        0,
    ),
    artifactChecksum:
      env.INDEXER_ARTIFACT_CHECKSUM ??
      env.CONTRACT_RELEASE_SHA256 ??
      ZERO_CHECKSUM,
  };
}

export function buildRoleChangeBinding(
  scope: RoleChangeCursorScope,
  release: CursorReleaseContext,
): CursorBindingInput {
  return {
    route: ROLE_CHANGE_CURSOR_ROUTE,
    schemaVersion: ROLE_CHANGE_CURSOR_SCHEMA_VERSION,
    sort: ROLE_CHANGE_CURSOR_SORT,
    filters: {
      chainId: scope.chainId,
      account: scope.account ? scope.account.toLowerCase() : null,
      role: scope.role ?? null,
    },
    release,
  };
}

export function encodeRoleChangePosition(key: RoleChangeOrderKey): string {
  return JSON.stringify([key.blockNumber, key.logIndex, key.txHash]);
}

export function decodeRoleChangePosition(position: string): RoleChangeOrderKey {
  try {
    const parsed: unknown = JSON.parse(position);
    if (!Array.isArray(parsed) || parsed.length !== 3) {
      throw new Error('malformed position');
    }
    const [blockNumber, logIndex, txHash] = parsed as unknown[];
    if (typeof blockNumber !== 'string' || !/^\d+$/.test(blockNumber)) {
      throw new Error('malformed block number');
    }
    if (
      typeof logIndex !== 'number' ||
      !Number.isSafeInteger(logIndex) ||
      logIndex < 0
    ) {
      throw new Error('malformed log index');
    }
    if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new Error('malformed tx hash');
    }
    return { blockNumber, logIndex, txHash };
  } catch {
    throw new CursorInvalidException('malformed_position');
  }
}
