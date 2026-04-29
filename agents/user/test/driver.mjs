/**
 * user-runtime acceptance driver.
 *
 * Two scenarios in sequence:
 *   Scenario 1: queryMarket() with default (Tier 1 only) — same as Block 1
 *   Scenario 2: queryMarket({ withTier2: true }) — full settle on chain
 *
 * Each scenario brings up no infrastructure of its own; acceptance.sh handles
 * AXL nodes + stubs + mock-supplier. We just call queryMarket twice and assert.
 */

import { UserRuntime } from '../src/runtime.mjs';
import { existsSync, readFileSync } from 'node:fs';

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
  bidWindowMs: 3000,
  deliveryTransport: 'send',
});

// =======================================================================
// Scenario 1: Tier 1 only (Block 1 behavior, regression check)
// =======================================================================

console.log('═══ Scenario 1: Tier 1 only ═══');
console.log('Posting marketplace query (canonical France prompt)...\n');

let r1;
try {
  r1 = await user.queryMarket({
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
  fail('Scenario 1: queryMarket end-to-end', e.message);
}

console.log('');
pass('S1: queryMarket completed without throwing');

if (typeof r1.tradeId === 'string' && r1.tradeId.startsWith('0x')) pass('S1: tradeId returned');
else fail('S1: tradeId malformed', JSON.stringify(r1.tradeId));

if (typeof r1.openTradeTx === 'string' && r1.openTradeTx.startsWith('0x')) pass('S1: openTradeTx returned');
else fail('S1: openTradeTx malformed');

if (typeof r1.settleTier1Tx === 'string' && r1.settleTier1Tx.startsWith('0x')) pass('S1: settleTier1Tx returned');
else fail('S1: settleTier1Tx malformed');

if (r1.settleTier2Tx === undefined) pass('S1: settleTier2Tx absent (Tier 2 not requested)');
else fail('S1: settleTier2Tx unexpectedly present');

if (r1.winningBid?.agentId === 'mock-supplier-1') pass('S1: winning bid is mock-supplier-1');
else fail('S1: winning bid wrong agent', JSON.stringify(r1.winningBid));

if (r1.deliver?.receipt?.det_hash) pass('S1: deliver receipt has det_hash');
else fail('S1: deliver missing receipt det_hash');

console.log('\nVerifying S1 on-chain settlement...');
const settled1 = await user.chain.isSettled(r1.tradeId);
if (settled1.tier1 === true) pass('S1: on-chain isSettled.tier1 = true');
else fail('S1: settleTier1 did not register', JSON.stringify(settled1));

if (settled1.tier2 === false) pass('S1: on-chain isSettled.tier2 = false (Tier 2 not settled)');
else fail('S1: tier2 unexpectedly true', JSON.stringify(settled1));

console.log('');
console.log(`  Trade ID:     ${r1.tradeId}`);
console.log(`  openTrade:    https://chainscan-galileo.0g.ai/tx/${r1.openTradeTx}`);
console.log(`  settleTier1:  https://chainscan-galileo.0g.ai/tx/${r1.settleTier1Tx}`);
console.log('');

// =======================================================================
// Scenario 2: Tier 1 + Tier 2 (Block 5 new path)
// =======================================================================

console.log('═══ Scenario 2: Tier 1 + Tier 2 ═══');
console.log('Posting marketplace query with withTier2: true...');
console.log(`Buyer pubkey (derived from WALLET_PRIVKEY): ${user.buyerPubkey.slice(0, 20)}...\n`);

let r2;
try {
  r2 = await user.queryMarket({
    promptLabel: 'The capital of France is',
    inputTokenIds: [785, 6722, 315, 9625, 374],
    maxOutputTokens: 20,
    decoding: 'greedy',
    budgetWei:        '1000000000000000',
    tier1AmountWei:   '100000000000000',
    tier2AmountWei:   '500000000000000',
    sellerAddr: '0x' + '11'.repeat(20),
    withTier2: true,
  });
} catch (e) {
  fail('Scenario 2: queryMarket end-to-end', e.message);
}

console.log('');
pass('S2: queryMarket(withTier2:true) completed without throwing');

if (typeof r2.tradeId === 'string' && r2.tradeId.startsWith('0x')) pass('S2: tradeId returned');
else fail('S2: tradeId malformed');

if (typeof r2.openTradeTx === 'string' && r2.openTradeTx.startsWith('0x')) pass('S2: openTradeTx returned');
else fail('S2: openTradeTx malformed');

if (typeof r2.settleTier1Tx === 'string' && r2.settleTier1Tx.startsWith('0x')) pass('S2: settleTier1Tx returned');
else fail('S2: settleTier1Tx malformed');

if (typeof r2.settleTier2Tx === 'string' && r2.settleTier2Tx.startsWith('0x')) pass('S2: settleTier2Tx returned');
else fail('S2: settleTier2Tx malformed', String(r2.settleTier2Tx));

if (r2.deliver?.attestation_tier2?.signature) pass('S2: deliver included Tier 2 attestation');
else fail('S2: missing attestation_tier2 in deliver');

if (r2.deliver?.attestation_tier2?.buyer_pubkey === user.buyerPubkey) {
  pass('S2: Tier 2 attestation bound to buyer pubkey');
} else {
  fail('S2: Tier 2 attestation has wrong buyer_pubkey',
       `expected ${user.buyerPubkey}, got ${r2.deliver?.attestation_tier2?.buyer_pubkey}`);
}

console.log('\nVerifying S2 on-chain settlement (both tiers)...');
const settled2 = await user.chain.isSettled(r2.tradeId);
if (settled2.tier1 === true) pass('S2: on-chain isSettled.tier1 = true');
else fail('S2: tier1 not settled', JSON.stringify(settled2));

if (settled2.tier2 === true) pass('S2: on-chain isSettled.tier2 = true');
else fail('S2: tier2 not settled', JSON.stringify(settled2));

// Verify the receipt JSON was written to disk (Block 7 input)
if (r2.receiptPath && existsSync(r2.receiptPath)) {
  pass(`S2: receipt JSON written to ${r2.receiptPath}`);
  const receiptJson = JSON.parse(readFileSync(r2.receiptPath, 'utf8'));
  if (receiptJson.verifier_attestation?.tier === 2) pass('S2: receipt JSON has tier=2 attestation');
  else fail('S2: receipt JSON missing tier=2 attestation');
  if (receiptJson.verifier_attestation?.buyer_pubkey === user.buyerPubkey) {
    pass('S2: receipt JSON has correct buyer_pubkey (Alice, NOT Carol)');
  } else {
    fail('S2: receipt JSON buyer_pubkey wrong',
         `expected ${user.buyerPubkey}, got ${receiptJson.verifier_attestation?.buyer_pubkey}`);
  }
} else {
  fail('S2: receipt JSON not written or path missing');
}

console.log('');
console.log(`  Trade ID:     ${r2.tradeId}`);
console.log(`  openTrade:    https://chainscan-galileo.0g.ai/tx/${r2.openTradeTx}`);
console.log(`  settleTier1:  https://chainscan-galileo.0g.ai/tx/${r2.settleTier1Tx}`);
console.log(`  settleTier2:  https://chainscan-galileo.0g.ai/tx/${r2.settleTier2Tx}`);
console.log(`  receipt:      ${r2.receiptPath}`);
console.log('');

console.log(`All ${testNum} tests passed.`);
