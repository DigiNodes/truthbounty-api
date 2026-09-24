// src/health/health-diagnostics.controller.ts
import { Controller, Get } from '@nestjs/common';
import { ContractArtifactsLoader } from '../contracts/contract-artifacts.loader';

@Controller('health')
export class HealthDiagnosticsController {
    constructor(private readonly artifactsLoader: ContractArtifactsLoader) {}

    @Get()
    getHealth() {
        return {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            contract_artifact_version: this.artifactsLoader.getActiveVersion(),
            chain: 'Optimism',
        };
    }
}