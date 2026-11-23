import { LocalFsIpfsProvider } from './ipfs.providers';
import { readFileSync, promises as fsPromises } from 'fs';
import path from 'path';
import { CID } from 'multiformats/cid';
import { verifyCIDIntegrity } from '../storage/cid-verifier';

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

  it('returns a valid CIDv1 for the uploaded bytes', async () => {
    const buf = Buffer.from('hello world');
    const stream = require('stream').Readable.from(buf);
    const res = await provider.add(stream, { filename: 'greeting.txt' });
    const parsed = CID.parse(res.cid);
    expect(parsed.version).toBe(1);
    expect(parsed.code).toBe(0x55);
    expect(await verifyCIDIntegrity(buf, res.cid)).toBe(true);
    expect(await verifyCIDIntegrity(Buffer.from('altered'), res.cid)).toBe(false);
    expect(res.size).toBe(buf.length);

    const stored = readFileSync(res.path!, 'utf8');
    expect(stored).toBe('hello world');
  });

  it('returns the same CID for repeated uploads of identical bytes', async () => {
    const first = await provider.add(
      require('stream').Readable.from(Buffer.from('repeat')),
    );
    const second = await provider.add(
      require('stream').Readable.from(Buffer.from('repeat')),
    );
    expect(second.cid).toBe(first.cid);
  });

  it('removes partial files when an upload stream fails', async () => {
    const stream = new (require('stream').Readable)({
      read() {
        this.push(Buffer.from('partial'));
        this.destroy(new Error('interrupted'));
      },
    });

    await expect(provider.add(stream)).rejects.toThrow('interrupted');
    expect(await fsPromises.readdir(tmpDir)).toEqual([]);
  });
});
