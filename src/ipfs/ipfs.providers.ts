import { Provider } from '@nestjs/common';
import { createWriteStream, promises as fsPromises } from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import crypto from 'crypto';
import { Readable, Transform } from 'stream';
import { IpfsProvider, IpfsAddResult, IPFS_PROVIDER } from './interfaces';
import { IpfsConfigService } from './ipfs.config';

export class LocalFsIpfsProvider implements IpfsProvider {
  constructor(private storagePath: string) {}

  async ensureDir() {
    await fsPromises.mkdir(this.storagePath, { recursive: true });
  }

  // Stream to a temp file, compute sha256 while streaming, then rename to content-hash
  async add(stream: Readable, opts?: { filename?: string }): Promise<IpfsAddResult> {
    await this.ensureDir();

    const tmpName = `ipfs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

    await pipeline(stream, transform, writeStream);

    const digest = hash.digest('hex');
    const cid = `sha256:${digest}`;

    const finalName = `${digest}`;
    const finalPath = path.join(this.storagePath, finalName);

    // move tmp file to final location (atomic on same fs)
    await fsPromises.rename(tmpPath, finalPath);

    return { cid, size, path: finalPath };
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

    // Placeholder: other providers (e.g. http client) can be added here
    throw new Error(`Unsupported IPFS provider: ${provider}`);
  },
  inject: [IpfsConfigService],
} as Provider;
