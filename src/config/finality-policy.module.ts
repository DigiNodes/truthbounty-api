import { Global, Module } from '@nestjs/common';
import { FinalityPolicyService } from './finality-policy.service';

/**
 * Global so FinalityPolicyService.onApplicationBootstrap runs the fail-closed
 * startup validation once, and every module (verification, disputes, claims,
 * blockchain) can inject it without a per-module import.
 */
@Global()
@Module({
  providers: [FinalityPolicyService],
  exports: [FinalityPolicyService],
})
export class FinalityPolicyModule {}
