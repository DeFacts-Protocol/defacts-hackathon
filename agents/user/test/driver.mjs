/**
 * user-runtime acceptance driver.
 *
 * Runs UserRuntime.queryMarket() against:
 *   - AXL node A (this runtime)
 *   - mock-supplier on AXL node B
 *   - prover-stub :7001
 *   - verifier-stub :7002
 *   - Escrow on Galileo
 *
 * Verifies an on-chain Tier1Settled event from a runtime-driven trade
 * (not a manual cast send).
 */

import { UserRuntime } from '../src/runtime.mjs';

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

// ─── Create the runtime ─────────────────────────────────────────────────

const user = new UserRuntime({
  axlApiBase: NODE_A_API,
  escrowAddr: ESCROW_ADDR,
  rpcUrl: ZERO_G_RPC_URL,
  privateKey: WALLET_PRIVKEY,
  proofFormat: 'stub-v1',
  bidWindowMs: 3000,
  deliveryTransport: 'send',  // /a2a requires AXL a2a backend; using /send for tests
});

// ─── Run queryMarket end-to-end ─────────────────────────────────────────

console.log('Posting marketplace query (canonical France prompt)...\n');

let result;
try {
  result = await user.queryMarket({
    promptLabel: 'The capital of France is',
    inputTokenIds: [785, 6722, 315, 9625, 374],
    maxOutputTokens: 20,
    decoding: 'greedy',
    budgetWei:        '1000000000000000',  // 0.001 0G — generous budget
    tier1AmountWei:   '100000000000000',   // 0.0001 0G
    tier2AmountWei:   '500000000000000',   // 0.0005 0G
    sellerAddr: '0x' + '11'.repeat(20),    // arbitrary recipient (settle-to-self requires us to be funded enough)
  });
} catch (e) {
  fail('queryMarket end-to-end', e.message);
}

console.log('');
pass('queryMarket completed without throwing');

// ─── Verify the result shape ────────────────────────────────────────────

if (typeof result.tradeId === 'string' && result.tradeId.startsWith('0x')) pass('tradeId returned');
else fail('tradeId malformed', JSON.stringify(result.tradeId));

if (typeof result.openTradeTx === 'string' && result.openTradeTx.startsWith('0x')) pass('openTradeTx returned');
else fail('openTradeTx malformed');

if (typeof result.settleTier1Tx === 'string' && result.settleTier1Tx.startsWith('0x')) pass('settleTier1Tx returned');
else fail('settleTier1Tx malformed');

if (result.winningBid?.agentId === 'mock-supplier-1') pass('winning bid is mock-supplier-1');
else fail('winning bid wrong agent', JSON.stringify(result.winningBid));

if (result.deliver?.receipt?.det_hash) pass('deliver included receipt with det_hash');
else fail('deliver missing receipt');

if (result.deliver?.attestation?.signature) pass('deliver included attestation with signature');
else fail('deliver missing attestation signature');

// ─── Verify on-chain settlement ─────────────────────────────────────────

console.log('\nVerifying on-chain settlement...');

const isSettled = await user.chain.isSettled(result.tradeId);
if (isSettled.tier1 === true) pass('on-chain isSettled.tier1 = true');
else fail('on-chain settlement did not register', JSON.stringify(isSettled));

if (isSettled.tier2 === false) pass('on-chain isSettled.tier2 = false (expected, Tier 2 ships Day 4)');
else fail('tier2 unexpectedly true', JSON.stringify(isSettled));

// ─── Print explorer URLs ────────────────────────────────────────────────

console.log('');
console.log(`Trade ID:     ${result.tradeId}`);
console.log(`openTrade:    https://chainscan-galileo.0g.ai/tx/${result.openTradeTx}`);
console.log(`settleTier1:  https://chainscan-galileo.0g.ai/tx/${result.settleTier1Tx}`);
console.log('');
console.log(`All ${testNum} tests passed.`);
