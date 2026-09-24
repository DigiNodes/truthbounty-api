import { LocalFsIpfsProvider } from './ipfs.providers';
import { readFileSync, promises as fsPromises } from 'fs';
import * as path from 'path';

describe('LocalFsIpfsProvider', () => {
  const tmpDir = path.join(process.cwd(), 'tmp-ipfs-test');
  let provider: LocalFsIpfsProvider;

  beforeAll(async () => {
    provider = new LocalFsIpfsProvider(tmpDir);
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('uploads buffer deterministically and returns cid', async () => {
    const buf = Buffer.from('hello world');
    const stream = require('stream').Readable.from(buf);
    const res = await provider.add(stream, { filename: 'greeting.txt' });
    expect(res.cid).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(res.size).toBe(buf.length);

    const stored = readFileSync(res.path!, 'utf8');
    expect(stored).toBe('hello world');
  });
});
