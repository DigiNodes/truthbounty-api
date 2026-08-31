// src/architecture.spec.ts
import * as fs from 'fs';
import * as path from 'path';

describe('V2 Architectural Module Boundaries & Dependency Enforcement', () => {
    const srcDir = path.resolve(__dirname);

    function scanDirectory(dir: string, fileList: string[] = []): string[] {
        const files = fs.readdirSync(dir);
        files.forEach((file) => {
            const filePath = path.join(dir, file);
            if (fs.statSync(filePath).isDirectory()) {
                scanDirectory(filePath, fileList);
            } else if (filePath.endsWith('.ts') && !filePath.endsWith('.spec.ts')) {
                fileList.push(filePath);
            }
        });
        return fileList;
    }

    it('should prohibit HTTP and WebSocket layers from importing protocol mutation or direct blockchain authority clients', () => {
        const allFiles = scanDirectory(srcDir);
        const presentationLayers = allFiles.filter(
            (f) => f.includes('/controllers/') || f.includes('/gateways/')
        );

        const forbiddenImports = [
            'ethers',
            'viem',
            '@ethersproject',
            'contract-mutator',
            'protocol-signer',
        ];

        for (const file of presentationLayers) {
            const content = fs.readFileSync(file, 'utf8');
            for (const forbidden of forbiddenImports) {
                expect(content).not.toContain(forbidden);
            }
        }
    });

    it('should enforce that queries and projections modules depend only on read-only read models', () => {
        const projectionFiles = scanDirectory(path.join(srcDir, 'projections'));
        for (const file of projectionFiles) {
            const content = fs.readFileSync(file, 'utf8');
            expect(content).not.toContain('MutationService');
            expect(content).not.toContain('TransactionSigner');
        }
    });
});