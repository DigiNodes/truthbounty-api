import { LocalFsIpfsProvider } from './ipfs.providers';
import { readFileSync, promises as fsPromises } from 'fs';
import path from 'path';
import { CID } from 'multiformats/cid';
import { base32 } from 'multiformats/bases/base32';
import { createHash } from 'node:crypto';

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

  it('uploads bytes under a deterministic canonical CIDv1', async () => {
    const buf = Buffer.from('hello world');
    const stream = require('stream').Readable.from(buf);
    const res = await provider.add(stream, { filename: 'greeting.txt' });
    const cid = CID.parse(res.cid);
    expect(cid.version).toBe(1);
    expect(cid.toString(base32)).toBe(res.cid);
    expect(Buffer.from(cid.multihash.digest)).toEqual(
      createHash('sha256').update(buf).digest(),
    );
    expect(res.size).toBe(buf.length);

    const stored = readFileSync(res.path!, 'utf8');
    expect(stored).toBe('hello world');
  });

  it('does not leave a partial object after an interrupted stream', async () => {
    const { Readable } = require('stream');
    const stream = new Readable({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('interrupted'));
      },
    });

    await expect(provider.add(stream)).rejects.toThrow('interrupted');
    expect(await fsPromises.readdir(tmpDir)).toEqual([]);
  });

  it('returns the same CID and stored path for repeated identical uploads', async () => {
    const { Readable } = require('stream');
    const bytes = Buffer.from('repeatable');
    const first = await provider.add(Readable.from(bytes));
    const second = await provider.add(Readable.from(bytes));

    expect(second.cid).toBe(first.cid);
    expect(second.path).toBe(first.path);
    expect(readFileSync(second.path!, 'utf8')).toBe('repeatable');
  });
});
