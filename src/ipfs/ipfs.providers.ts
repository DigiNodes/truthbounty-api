import { Provider } from '@nestjs/common';
import { createWriteStream, promises as fsPromises } from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import crypto from 'crypto';
import { Readable, Transform } from 'stream';
import { CID } from 'multiformats/cid';
import { base32 } from 'multiformats/bases/base32';
import * as Digest from 'multiformats/hashes/digest';
import { sha256 } from 'multiformats/hashes/sha2';
import * as raw from 'multiformats/codecs/raw';
import { IpfsProvider, IpfsAddResult, IPFS_PROVIDER } from './interfaces';
import { IpfsConfigService } from './ipfs.config';

export class LocalFsIpfsProvider implements IpfsProvider {
  constructor(private storagePath: string) {}

  async ensureDir() {
    await fsPromises.mkdir(this.storagePath, { recursive: true });
  }

  // Stream to a temp file, compute sha256 while streaming, then rename to its CID.
  async add(
    stream: Readable,
    opts?: { filename?: string },
  ): Promise<IpfsAddResult> {
    await this.ensureDir();

    const tmpName = `ipfs-${crypto.randomUUID()}.tmp`;
    const tmpPath = path.join(this.storagePath, tmpName);

    const hash = crypto.createHash('sha256');
    let size = 0;

    const writeStream = createWriteStream(tmpPath, { flags: 'w' });

    // Pipe original stream through a transform that counts bytes and updates hash
    const transform = new Transform({
      transform(chunk: Buffer, _enc: string, cb: Function) {
        size += chunk.length;
        hash.update(chunk);
        cb(null, chunk);
      },
    });

    try {
      await pipeline(stream, transform, writeStream);

      const digest = Digest.create(sha256.code, hash.digest());
      const cid = CID.createV1(raw.code, digest).toString(base32);
      const finalPath = path.join(this.storagePath, cid);

      // Move the completed file atomically on the same filesystem.
      await fsPromises.rename(tmpPath, finalPath);

      return { cid, size, path: finalPath };
    } catch (error) {
      await fsPromises.rm(tmpPath, { force: true });
      throw error;
    }
  }

  getUrl(cid: string): string | undefined {
    return undefined;
  }
}

export const ipfsProviderFactory = {
  provide: IPFS_PROVIDER,
  useFactory: (cfg: IpfsConfigService) => {
    const { provider, localStoragePath } = cfg.getConfig();
    if (provider === 'local') {
      const storage = path.isAbsolute(localStoragePath)
        ? localStoragePath
        : path.join(process.cwd(), localStoragePath);
      return new LocalFsIpfsProvider(storage) as IpfsProvider;
    }

    throw new Error('Invalid IPFS configuration: unsupported provider');
  },
  inject: [IpfsConfigService],
} as Provider;
