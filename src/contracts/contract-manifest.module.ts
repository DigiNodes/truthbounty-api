import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ContractManifestValidatorService } from './contract-manifest-validator.service';
import { ManifestReadinessService } from './manifest-readiness.service';

/**
 * ContractManifestModule
 *
 * Registers the ContractManifestValidatorService and ManifestReadinessService
 * as independently reviewable, importable NestJS providers.
 *
 * Startup sequence
 * ----------------
 * 1. ManifestReadinessService is instantiated. isReady() starts as false.
 * 2. ContractManifestValidatorService.onApplicationBootstrap() runs; it
 *    drives the readiness service:
 *      - On success: calls manifestReadinessService.markReady(...)
 *      - On failure: calls manifestReadinessService.markFailed(...) then throws
 * 3. Any consumer that depends on validated manifest state should inject
 *    ManifestReadinessService and check isReady() before proceeding.
 *
 * Import this module wherever the validated manifest or readiness gate is
 * required. The indexer, blockchain, and any module that reads contract
 * addresses should depend on this module to guarantee they never start with
 * an unvalidated manifest.
 */
@Module({
  imports: [ConfigModule],
  providers: [ManifestReadinessService, ContractManifestValidatorService],
  exports: [ManifestReadinessService, ContractManifestValidatorService],
})
export class ContractManifestModule {}
