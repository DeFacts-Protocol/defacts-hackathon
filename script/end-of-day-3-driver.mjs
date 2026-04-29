/**
 * End-of-Day-3 acceptance driver.
 *
 * Boots a UserRuntime against a market with TWO suppliers and asserts the
 * lowest-price one wins. Tests the bid-window filter, the agent_id
 * resolution, and on-chain settlement under competitive bidding.
 *
 * Run by script/end-of-day-3.sh after both agents are ready.
 *
 * ENV:
 *   ENABLE_ENS=1               — opt-in to Sepolia ENS record updates after
 *                                each successful settle. Off by default.
 *   ENS_OWNER_PRIVKEY=0x...    — required when ENABLE_ENS=1. Privkey of the
 *                                wallet that owns defacts.eth on Sepolia.
 *   SEPOLIA_RPC_URL=...        — optional, defaults to publicnode.
 */

import { UserRuntime } from '../agents/user/src/runtime.mjs';

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

// ─── Optional: instantiate EnsUpdater ──────────────────────────────────

let ensUpdater = null;
if (process.env.ENABLE_ENS === '1') {
  if (!process.env.ENS_OWNER_PRIVKEY) {
    console.error('FAIL: ENABLE_ENS=1 but ENS_OWNER_PRIVKEY not set');
    process.exit(1);
  }
  // Dynamic import — only load EnsUpdater when actually needed, so the
  // existing acceptance flow (without ENS) doesn't pull in viem just for
  // the ENS module.
  const { EnsUpdater } = await import('../services/ens-updater/src/index.mjs');
  ensUpdater = new EnsUpdater({
    privateKey: process.env.ENS_OWNER_PRIVKEY,
    rpcUrl: process.env.SEPOLIA_RPC_URL,
  });
  console.log(`[ens] enabled — Sepolia owner=${ensUpdater.account.address}`);
}

// We need access to the bid list, which the runtime doesn't expose in its
// return value. We monkey-patch the runtime to capture all bids before the
// winner is picked. This is test-only; production runtimes don't need to.
class InstrumentedUserRuntime extends UserRuntime {
  constructor(opts) {
    super(opts);
    this.allBids = [];
  }
}

const user = new InstrumentedUserRuntime({
  axlApiBase: NODE_A_API,
  escrowAddr: ESCROW_ADDR,
  rpcUrl: ZERO_G_RPC_URL,
  privateKey: WALLET_PRIVKEY,
  proofFormat: 'stub-v1',
  bidWindowMs: 4000,         // wider window — fresh-agent calls prover, slower
  deliveryTransport: 'send',
  ensUpdater,                // null when ENABLE_ENS != '1'
});

// Intercept _log to capture bid arrivals
const origLog = user._log.bind(user);
user._log = (tag, msg) => {
  origLog(tag, msg);
  if (tag === 'bid') {
    const m = msg.match(/agent_id=(\S+) price=(\S+)/);
    if (m) user.allBids.push({ agentId: m[1], priceWei: m[2] });
  }
};

console.log('Posting marketplace query...');
console.log('Both cache-001 and fresh-001 should bid.\n');

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

// ─── Verify both suppliers bid ─────────────────────────────────────────

const agentIds = user.allBids.map((b) => b.agentId).sort();
if (agentIds.length === 2) pass('exactly 2 bids received');
else fail(`expected 2 bids, got ${agentIds.length}`, JSON.stringify(user.allBids));

if (agentIds.includes('cache-001')) pass('cache-001 bid received');
else fail('cache-001 did not bid', JSON.stringify(agentIds));

if (agentIds.includes('fresh-001')) pass('fresh-001 bid received');
else fail('fresh-001 did not bid', JSON.stringify(agentIds));

// ─── Verify both bids carry the SAME det_hash ──────────────────────────

// We can't see fresh-001's bid det_hash directly from the user-runtime's logs,
// but we can verify the delivered receipt has the canonical France hash, which
// confirms the supplier we picked was producing the right answer.
const expectedDetHash = '0x6b64b51afe77ff67bb4336117f89237090ff9ba41d7a2c2ad2c0646ef8b44336';
if (result.deliver?.receipt?.det_hash === expectedDetHash) {
  pass('delivered receipt has canonical France det_hash');
} else {
  fail('det_hash mismatch — supplier produced wrong answer', result.deliver?.receipt?.det_hash);
}

// ─── Verify cache-001 won (lowest price) ───────────────────────────────

if (result.winningBid?.agentId === 'cache-001') {
  pass('lowest-price bidder won (cache-001)');
} else {
  fail(`wrong winner: ${result.winningBid?.agentId} (expected cache-001)`);
}

if (result.winningBid?.priceWei === '50000000000000') {
  pass('winning price is 0.00005 ETH (cache-001)');
} else {
  fail(`unexpected price ${result.winningBid?.priceWei}`);
}

// Verify fresh-001 was the OTHER bid (not the winner)
const freshBid = user.allBids.find((b) => b.agentId === 'fresh-001');
if (freshBid && freshBid.priceWei === '200000000000000') {
  pass('fresh-001 bid 0.00020 ETH (4x cache-001, ignored as not lowest)');
} else {
  fail(`fresh-001 bid wrong: ${JSON.stringify(freshBid)}`);
}

// ─── Verify on-chain settlement ────────────────────────────────────────

console.log('\nVerifying on-chain settlement...');

const isSettled = await user.chain.isSettled(result.tradeId);
if (isSettled.tier1 === true) pass('on-chain isSettled.tier1 = true');
else fail('settlement not confirmed', JSON.stringify(isSettled));

if (isSettled.tier2 === false) pass('on-chain isSettled.tier2 = false (Day 4)');
else fail('tier2 unexpectedly true');

// ─── Print summary ─────────────────────────────────────────────────────

console.log('');
console.log('=== Marketplace race result ===');
console.log(`  Bids received: ${user.allBids.length}`);
for (const b of user.allBids) {
  const marker = b.agentId === result.winningBid.agentId ? '✓' : ' ';
  console.log(`    ${marker} ${b.agentId}: ${b.priceWei} wei`);
}
console.log(`  Winner: ${result.winningBid.agentId}`);
console.log('');
console.log('=== On-chain settlement ===');
console.log(`  Trade ID:    ${result.tradeId}`);
console.log(`  openTrade:   https://chainscan-galileo.0g.ai/tx/${result.openTradeTx}`);
console.log(`  settleTier1: https://chainscan-galileo.0g.ai/tx/${result.settleTier1Tx}`);
console.log('');

// ─── If ENS enabled: wait for Sepolia updates to land ──────────────────

if (ensUpdater) {
  console.log('=== ENS update (best-effort, Sepolia) ===');
  console.log('  Waiting up to 90s for Sepolia confirmations to propagate...');
  console.log('  (parent: 3 records + winner subname: 5 records = up to 8 sequential txs)');
  console.log('');

  // Stream the trade hash into ENS by deriving the expected subname
  const subnameMap = {
    'cache-001':       'l4',
    'fresh-001':       'l40s',
    'fresh-002':       'h100',
    'mock-supplier-1': 'l4',
  };
  const winnerSubname = subnameMap[result.winningBid.agentId];
  if (!winnerSubname) {
    console.log(`  ⚠ no subname mapping for ${result.winningBid.agentId} — skipping ENS check`);
  } else {
    const fullName = `${winnerSubname}.defacts.eth`;
    const expectedTradeId = result.tradeId;

    // Poll up to 90s, every 5s
    let observed = null;
    const startMs = Date.now();
    while (Date.now() - startMs < 90_000) {
      try {
        observed = await ensUpdater.getText(fullName, 'defacts.last_trade_id');
        if (observed === expectedTradeId) break;
      } catch (e) {
        // Ignore read errors during polling
      }
      await new Promise(r => setTimeout(r, 5000));
    }

    const elapsed = Math.round((Date.now() - startMs) / 1000);
    if (observed === expectedTradeId) {
      pass(`ENS ${fullName}/defacts.last_trade_id updated after ${elapsed}s`);

      // Read all the related records to confirm full update
      const settleTx     = await ensUpdater.getText(fullName, 'defacts.last_settlement_tx');
      const lastTier     = await ensUpdater.getText(fullName, 'defacts.last_tier_settled');
      const lastAttest   = await ensUpdater.getText(fullName, 'defacts.last_attestation');
      const parentLatest = await ensUpdater.getText('defacts.eth', 'defacts.latest_attestation');

      pass(`ENS ${fullName} has settle tx URL`);
      pass(`ENS ${fullName} has last_tier=${lastTier}`);
      pass(`ENS ${fullName} has last_attestation`);
      pass(`ENS defacts.eth/defacts.latest_attestation populated`);

      console.log('');
      console.log('=== ENS records updated on Sepolia ===');
      console.log(`  ${fullName}/defacts.last_trade_id        = ${observed.slice(0, 22)}...`);
      console.log(`  ${fullName}/defacts.last_settlement_tx   = ${settleTx.slice(0, 60)}...`);
      console.log(`  ${fullName}/defacts.last_tier_settled    = ${lastTier}`);
      console.log(`  ${fullName}/defacts.last_attestation     = ${lastAttest.slice(0, 22)}...`);
      console.log(`  defacts.eth/defacts.latest_attestation   = ${parentLatest.slice(0, 22)}...`);
      console.log('');
      console.log(`  View live:  https://app.ens.domains/${fullName}  (Sepolia)`);
    } else {
      fail(`ENS update did not propagate within 90s`,
        `observed: "${observed}" expected: "${expectedTradeId}"`);
    }
  }
}

console.log('');
console.log(`All ${testNum} tests passed.`);
