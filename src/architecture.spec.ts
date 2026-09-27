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
        // Projectors live under */projectors/ (e.g. src/indexer/projectors,
        // src/claims/claim-projector.service.ts is a sibling; the historical
        // src/projections directory no longer exists).
        const allFiles = scanDirectory(srcDir);
        const projectionFiles = allFiles.filter(
            (f) => f.includes(`${path.sep}projectors${path.sep}`) || f.includes('Projector'),
        );
        expect(projectionFiles.length).toBeGreaterThan(0);
        for (const file of projectionFiles) {
            const content = fs.readFileSync(file, 'utf8');
            expect(content).not.toContain('MutationService');
            expect(content).not.toContain('TransactionSigner');
        }
    });

    it('should enforce the TypeORM-only persistence boundary (V2-BE-111): no new Prisma usage outside the grandfathered module list', () => {
        // Real, load-bearing Prisma usage predates this rule and is not
        // being migrated as part of this change (that's a separate, much
        // larger effort). This list should only ever shrink.
        const grandfatheredPrismaFiles = [
            'prisma/prisma.module.ts',
            'prisma/prisma.service.ts',
            'auth/auth.service.ts',
            'notifications/services/notifications.service.ts',
            'outbox/outbox.service.ts',
            'sybil-resistance/sybil-resistance.service.ts',
            'analytics/analytics.service.ts',
            'ai-assistant/ai-assistant.service.ts',
            'ai-assistant/rag.service.ts',
            'ai-assistant/services/ai-assistant.service.ts',
            'ai-assistant/services/rag.service.ts',
            'identity/identity.service.ts',
            'identity/worldcoin/worldcoin.service.ts',
        ].map((relativePath) => path.join(srcDir, relativePath));

        const allFiles = scanDirectory(srcDir).filter(
            (f) => !f.includes(`${path.sep}generated${path.sep}`),
        );
        const candidateFiles = allFiles.filter(
            (f) => !grandfatheredPrismaFiles.includes(f),
        );

        const forbiddenPrismaImports = ['@prisma/client', 'prisma.service'];
        const offendingFiles: string[] = [];

        for (const file of candidateFiles) {
            const content = fs.readFileSync(file, 'utf8');
            if (forbiddenPrismaImports.some((forbidden) => content.includes(forbidden))) {
                offendingFiles.push(path.relative(srcDir, file));
            }
        }

        expect(offendingFiles).toEqual([]);
    });
});