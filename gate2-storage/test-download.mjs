import { Indexer } from '@0gfoundation/0g-ts-sdk';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';

const INDEXER_RPC = 'https://indexer-storage-testnet-turbo.0g.ai';
const indexer = new Indexer(INDEXER_RPC);

const { rootHash } = JSON.parse(readFileSync('./upload-result.json', 'utf-8'));
console.log(`Fetching root: ${rootHash}`);

const outPath = './downloaded.json';
if (existsSync(outPath)) unlinkSync(outPath);

const err = await indexer.download(rootHash, outPath, true);
if (err !== null) {
  console.error(`Download failed: ${err}`);
  process.exit(1);
}

const downloaded = readFileSync(outPath);
console.log(`Downloaded ${downloaded.length} bytes`);

const sha = createHash('sha256').update(downloaded).digest('hex');
console.log(`SHA-256: ${sha}`);
console.log(`First 200 chars: ${downloaded.toString('utf-8').slice(0, 200)}`);
