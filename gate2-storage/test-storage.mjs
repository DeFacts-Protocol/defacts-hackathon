import { MemData, Indexer } from '@0gfoundation/0g-ts-sdk';
import { ethers } from 'ethers';
import { readFileSync } from 'fs';

// Load .env from parent dir
const envText = readFileSync('../.env', 'utf-8');
const env = Object.fromEntries(
  envText.split('\n')
    .filter(l => l && !l.startsWith('#'))
    .map(l => l.split('=').map(s => s.trim()))
);

const RPC_URL = env.ZERO_G_RPC_URL;
const INDEXER_RPC = 'https://indexer-storage-testnet-turbo.0g.ai';
const PRIVATE_KEY = env.WALLET_PRIVKEY;

const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);
const indexer = new Indexer(INDEXER_RPC);

// Build a ~1KB JSON blob — pad with deterministic content so we can verify byte-equality
const payload = {
  test: 'defacts-gate-2',
  ts: new Date().toISOString(),
  message: 'hello 0g storage',
  pad: 'x'.repeat(900),
};
const bytes = new TextEncoder().encode(JSON.stringify(payload));
console.log(`Uploading ${bytes.length} bytes...`);

const memData = new MemData(bytes);
const [tree, treeErr] = await memData.merkleTree();
if (treeErr !== null) throw new Error(`merkleTree: ${treeErr}`);
const rootHash = tree.rootHash();
console.log(`Computed root hash: ${rootHash}`);

const [tx, uploadErr] = await indexer.upload(memData, RPC_URL, signer);
if (uploadErr !== null) throw new Error(`upload: ${uploadErr}`);
console.log('Upload result:', tx);

console.log(`\nRoot hash to remember: ${rootHash}`);
console.log('Save this — Step 4 will fetch it back.');
