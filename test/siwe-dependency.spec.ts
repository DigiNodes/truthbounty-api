import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

describe('SIWE Nonce Service Dependency Boundary (PREWAVE-BE-013 / #609)', () => {
  const root = join(__dirname, '..');
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const siweNonceServiceSource = readFileSync(
    join(root, 'src', 'auth', 'siwe-nonce.service.ts'),
    'utf8',
  );
  const siweTypesPath = join(root, 'src', 'auth', 'types', 'siwe-module.d.ts');

  describe('1. Canonical SIWE Dependency Declaration and Clean Install Resolution', () => {
    it('declares the reviewed siwe dependency in package.json', () => {
      expect(packageJson.dependencies).toBeDefined();
      expect(packageJson.dependencies.siwe).toBeDefined();
      expect(packageJson.dependencies.siwe).toMatch(/^\^?2\.3\.2/);
    });

    it('resolves the canonical siwe package and tree in package-lock.json', () => {
      expect(packageLock.packages[''].dependencies.siwe).toBeDefined();
      expect(packageLock.packages['node_modules/siwe']).toBeDefined();
      expect(packageLock.packages['node_modules/siwe'].version).toBe('2.3.2');
      expect(packageLock.packages['node_modules/siwe'].integrity).toBeDefined();
      expect(packageLock.packages['node_modules/@spruceid/siwe-parser']).toBeDefined();
    });
  });

  describe('2. Ambient Type Declarations for Compilation Gates', () => {
    it('provides type declarations for the siwe module', () => {
      expect(existsSync(siweTypesPath)).toBe(true);
      const content = readFileSync(siweTypesPath, 'utf8');

      expect(content).toContain("declare module 'siwe'");
      expect(content).toContain('export function generateNonce(): string');
      expect(content).toContain('export class SiweMessage');
      expect(content).toContain('export interface SiweResponse');
      expect(content).toContain('export enum SiweErrorType');
    });
  });

  describe('3. Canonical Import and Service Boundary in siwe-nonce.service.ts', () => {
    it('imports generateNonce from siwe package instead of crypto random bytes', () => {
      expect(siweNonceServiceSource).toContain("import { generateNonce } from 'siwe'");
      expect(siweNonceServiceSource).not.toContain("from 'crypto'");
      expect(siweNonceServiceSource).toContain('const nonce = generateNonce();');
    });

    it('exposes race-safe single-use consumeNonce method', () => {
      expect(siweNonceServiceSource).toContain('async consumeNonce(');
      expect(siweNonceServiceSource).toContain('UPDATE "v2_auth_nonces" SET "used" = TRUE');
      expect(siweNonceServiceSource).toContain('"used" = FALSE');
      expect(siweNonceServiceSource).toContain('"expires_at" >');
    });

    it('enforces fail-closed validation for wallet address, URI, and chain ID', () => {
      expect(siweNonceServiceSource).toContain('assertValidAddress');
      expect(siweNonceServiceSource).toContain('assertValidUri');
      expect(siweNonceServiceSource).toContain('assertValidChainId');
      expect(siweNonceServiceSource).toContain('assertValidNonce');
    });
  });
});
