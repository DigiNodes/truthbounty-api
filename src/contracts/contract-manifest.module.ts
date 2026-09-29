import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ContractManifestValidatorService } from './contract-manifest-validator.service';

/**
 * ContractManifestModule
 *
 * Registers the ContractManifestValidatorService as an independently
 * reviewable, importable NestJS module. The validator runs at
 * onApplicationBootstrap and throws (fail-closed) when the manifest is absent,
 * structurally invalid, stale, or fails on-chain code verification.
 *
 * Import this module wherever the validated manifest is required. The indexer,
 * blockchain, and any module that reads contract addresses should depend on
 * this module to guarantee they never start with an unvalidated manifest.
 */
@Module({
  imports: [ConfigModule],
  providers: [ContractManifestValidatorService],
  exports: [ContractManifestValidatorService],
})
export class ContractManifestModule {}
