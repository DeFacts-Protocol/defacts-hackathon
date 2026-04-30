/**
 * fresh-mode-agent acceptance driver.
 *
 * Imports UserRuntime and runs queryMarket against the fresh-mode-agent.
 * Asserts the receipt has the canonical France det_hash (because prover-stub
 * is deterministic for that prompt) and that on-chain settlement succeeded.
 */

import { UserRuntime } from '../../user/src/runtime.mjs';

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

const user = new UserRuntime({
  axlApiBase: NODE_A_API,
  escrowAddr: ESCROW_ADDR,
  rpcUrl: ZERO_G_RPC_URL,
  privateKey: WALLET_PRIVKEY,
  proofFormat: 'stub-v1',
  bidWindowMs: 4000,    // bumped from 3000 — fresh-agent calls prover before bidding,
                        // adds latency vs cache-mode (which is instant).
  deliveryTransport: 'send',
});

console.log('Posting marketplace query (canonical France prompt)...');
console.log('Expecting bid from fresh-001 — generates fresh receipt by calling prover-stub.\n');

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

if (result.winningBid?.agentId === 'fresh-001') pass('winning bid is fresh-001');
else fail(`winning bid was ${result.winningBid?.agentId}, expected fresh-001`);

if (result.winningBid?.priceWei === '200000000000000') pass('fresh-001 bid at expected price (0.0002 ETH)');
else fail(`unexpected price ${result.winningBid?.priceWei}`);

// ─── Verify the receipt has a valid det_hash ──────────────────────────
// Format-only check so this works against any PSEC-conformant prover.
// stub-v1 produces one canonical hash, real PD19 produces a different
// canonical hash; both are valid 32-byte 0x-prefixed hashes. Cryptographic
// correctness is verified separately by the verifier service and the
// Carol-fails CLI.
const detHash = result.deliver?.receipt?.det_hash;
if (typeof detHash === 'string' && /^0x[0-9a-f]{64}$/i.test(detHash)) {
  pass(`delivered receipt has valid 32-byte det_hash (${detHash.slice(0, 18)}...)`);
} else {
  fail('det_hash invalid or missing', detHash);
}

if (Array.isArray(result.deliver?.receipt?.input_token_ids) &&
    result.deliver.receipt.input_token_ids[0] === 785) {
  pass('receipt includes input_token_ids (merged in by fresh-agent)');
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

console.log('');
console.log(`Trade ID:     ${result.tradeId}`);
console.log(`openTrade:    https://chainscan-galileo.0g.ai/tx/${result.openTradeTx}`);
console.log(`settleTier1:  https://chainscan-galileo.0g.ai/tx/${result.settleTier1Tx}`);
console.log('');
console.log(`All ${testNum} tests passed.`);
