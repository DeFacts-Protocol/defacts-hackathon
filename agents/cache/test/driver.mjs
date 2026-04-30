/**
 * cache-mode-agent acceptance driver.
 *
 * Imports the UserRuntime from agents/user/ and runs queryMarket against
 * the cache-mode-agent running on node B. End-to-end test of the runtime →
 * cache-agent integration with on-chain settlement.
 */

import { UserRuntime } from '../../user/src/runtime.mjs';
import { readFile } from 'node:fs/promises';

const NODE_A_API     = process.env.NODE_A_API;
const ESCROW_ADDR    = process.env.ESCROW_ADDR;
const ZERO_G_RPC_URL = process.env.ZERO_G_RPC_URL;
const WALLET_PRIVKEY = process.env.WALLET_PRIVKEY;

if (!NODE_A_API || !ESCROW_ADDR || !ZERO_G_RPC_URL || !WALLET_PRIVKEY) {
  console.error('FAIL: required env vars missing');
  process.exit(1);
}

let testNum = 0;
function pass(label) { console.log(`✓ Test ${++testNum}: ${label}`); }
function fail(label, detail) {
  console.error(`✗ Test ${++testNum}: ${label}`);
  if (detail) console.error('  ', detail);
  process.exit(1);
}

// ─── Run the marketplace query against cache-mode-agent ────────────────

const user = new UserRuntime({
  axlApiBase: NODE_A_API,
  escrowAddr: ESCROW_ADDR,
  rpcUrl: ZERO_G_RPC_URL,
  privateKey: WALLET_PRIVKEY,
  proofFormat: 'stub-v1',
  bidWindowMs: 3000,
  deliveryTransport: 'send',
});

console.log('Posting marketplace query (canonical France prompt)...');
console.log('Expecting bid from cache-001 since it has france.json cached.\n');

let result;
try {
  result = await user.queryMarket({
    promptLabel: 'The capital of France is',
    inputTokenIds: [785, 6722, 315, 9625, 374],
    maxOutputTokens: 20,
    decoding: 'greedy',
    budgetWei:        '1000000000000000',
    tier1AmountWei:   '100000000000000',
    tier2AmountWei:   '500000000000000',
    sellerAddr: '0x' + '11'.repeat(20),
  });
} catch (e) {
  fail('queryMarket end-to-end', e.message);
}

console.log('');
pass('queryMarket completed without throwing');

// ─── Verify the right agent won ────────────────────────────────────────

if (result.winningBid?.agentId === 'cache-001') pass('winning bid is cache-001');
else fail(`winning bid was ${result.winningBid?.agentId}, expected cache-001`);

if (result.winningBid?.priceWei === '50000000000000') pass('cache-001 bid at expected price (0.00005 ETH)');
else fail(`unexpected price ${result.winningBid?.priceWei}`);

// ─── Verify the receipt is the cached one ──────────────────────────────

const fixturePath = new URL('../fixtures/france.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const expectedDetHash = fixture.det_hash;

if (result.deliver?.receipt?.det_hash === expectedDetHash) {
  pass(`delivered receipt matches cache fixture (${expectedDetHash.slice(0, 18)}...)`);
} else {
  fail(
    'det_hash mismatch — cache served different receipt than the fixture',
    `expected=${expectedDetHash} actual=${result.deliver?.receipt?.det_hash}`
  );
}

if (Array.isArray(result.deliver?.receipt?.input_token_ids) &&
    result.deliver.receipt.input_token_ids[0] === 785) {
  pass('receipt includes input_token_ids');
} else {
  fail('receipt missing input_token_ids');
}

if (Array.isArray(result.deliver?.receipt?.output_token_ids) &&
    result.deliver.receipt.output_token_ids.length === 20) {
  pass('receipt has 20 output tokens');
} else {
  fail('output_token_ids wrong length');
}

// ─── Verify on-chain settlement ────────────────────────────────────────

console.log('\nVerifying on-chain settlement...');

const isSettled = await user.chain.isSettled(result.tradeId);
if (isSettled.tier1 === true) pass('on-chain isSettled.tier1 = true');
else fail('settlement not confirmed', JSON.stringify(isSettled));

if (isSettled.tier2 === false) pass('on-chain isSettled.tier2 = false (Day 4 work)');
else fail('tier2 unexpectedly true');

// ─── Print explorer URLs ───────────────────────────────────────────────

console.log('');
console.log(`Trade ID:     ${result.tradeId}`);
console.log(`openTrade:    https://chainscan-galileo.0g.ai/tx/${result.openTradeTx}`);
console.log(`settleTier1:  https://chainscan-galileo.0g.ai/tx/${result.settleTier1Tx}`);
console.log('');
console.log(`All ${testNum} tests passed.`);
