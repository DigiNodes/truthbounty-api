import { Injectable, OnModuleInit, Logger, InternalServerErrorException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface ContractArtifacts {
    version: string;
    chainId: number;
    contracts: Record<string, { address: string; abi: any[]; checksum: string }>;
}

@Injectable()
export class ContractArtifactsLoader implements OnModuleInit {
    private readonly logger = new Logger(ContractArtifactsLoader.name);
    private artifacts: ContractArtifacts;
    private readonly artifactsPath = path.resolve(process.cwd(), 'config/contracts/release-artifacts.json');

    onModuleInit(): void {
        this.loadAndVerifyArtifacts();
    }

    private loadAndVerifyArtifacts(): void {
        this.logger.log('Loading canonical contract release artifacts...');

        if (!fs.existsSync(this.artifactsPath)) {
            throw new InternalServerErrorException(
                `Critical: Release artifacts file not found at path: ${this.artifactsPath}. Hand-maintained fragments are prohibited.`
            );
        }

        try {
            const rawData = fs.readFileSync(this.artifactsPath, 'utf8');
            const parsed: ContractArtifacts = JSON.parse(rawData);

            // Validate schema structure & checksums
            if (!parsed.version || !parsed.contracts) {
                throw new InternalServerErrorException('Invalid contract artifacts schema structure.');
            }

            for (const [name, contract] of Object.entries(parsed.contracts)) {
                if (!contract.address || !/^0x[a-fA-F0-9]{40}$/.test(contract.address)) {
                    throw new InternalServerErrorException(`Invalid or dummy address detected for contract: ${name}`);
                }
                if (contract.address === '0x0000000000000000000000000000000000000000') {
                    throw new InternalServerErrorException(`Zero/dummy address prohibited for contract: ${name}`);
                }

                // Verify cryptographic checksum of ABI
                const computedChecksum = crypto
                    .createSHA256()
                    .update(JSON.stringify(contract.abi))
                    .digest('hex');

                if (contract.checksum && contract.checksum !== computedChecksum) {
                    throw new InternalServerErrorException(`ABI checksum mismatch for contract: ${name}`);
                }
            }

            this.artifacts = parsed;
            this.logger.log(`Successfully loaded contract release artifacts version: ${parsed.version}`);
        } catch (error) {
            this.logger.error(`Failed to load release artifacts: ${error.message}`);
            process.exit(1);
        }
    }

    getArtifacts(): ContractArtifacts {
        return this.artifacts;
    }

    getActiveVersion(): string {
        return this.artifacts?.version || 'unknown';
    }
}