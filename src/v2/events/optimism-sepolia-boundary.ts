import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import {
  generateDecoderAllowlist,
  CanonicalDecoderAllowlist,
  RawReleaseManifest,
} from './decoder-allowlist';

export class OptimismSepoliaDecoderBoundary {
  private static instance: OptimismSepoliaDecoderBoundary | null = null;
  private readonly allowlist: CanonicalDecoderAllowlist;

  constructor(manifestPath?: string) {
    const targetPath =
      manifestPath ||
      resolve(
        __dirname,
        '../../../contracts/manifests/optimism-sepolia.release.json',
      );

    if (!existsSync(targetPath)) {
      throw new Error(
        `Canonical release manifest not found at: ${targetPath}. System fails closed.`,
      );
    }

    const raw = JSON.parse(readFileSync(targetPath, 'utf-8')) as RawReleaseManifest;
    const result = generateDecoderAllowlist(raw);

    if (!result.valid || !result.allowlist) {
      throw new Error(
        `Optimism Sepolia Decoder Allowlist generation failed at startup:\n${result.errors.join(
          '\n',
        )}`,
      );
    }

    this.allowlist = result.allowlist;
  }

  public static getInstance(manifestPath?: string): OptimismSepoliaDecoderBoundary {
    if (!OptimismSepoliaDecoderBoundary.instance) {
      OptimismSepoliaDecoderBoundary.instance =
        new OptimismSepoliaDecoderBoundary(manifestPath);
    }
    return OptimismSepoliaDecoderBoundary.instance;
  }

  public getAllowlist(): CanonicalDecoderAllowlist {
    return this.allowlist;
  }

  public isAddressAllowed(address: string): boolean {
    return this.allowlist.allowedAddresses.includes(address.toLowerCase());
  }

  public isTopicAllowed(topic0: string): boolean {
    return this.allowlist.allowedTopic0s.includes(topic0.toLowerCase());
  }

  public getReleaseProvenance() {
    return {
      releaseId: this.allowlist.releaseId,
      chainId: this.allowlist.chainId,
      deploymentBlock: this.allowlist.deploymentBlock,
      manifestChecksum: this.allowlist.manifestChecksum,
      version: this.allowlist.version,
    };
  }
}
