#!/usr/bin/env node
/**
 * defacts-verify — receipt verification CLI demonstrating non-resale.
 *
 * The pivotal demo beat:
 *   1. Alice buys a receipt with Tier 2 attestation. The attestation is
 *      EIP-712 signed by the verifier over (psec_version, model_commitment,
 *      input_hash, output_hash, tier=2, buyer_pubkey=ALICE_PUBKEY).
 *   2. Alice can verify the receipt: she presents her pubkey, the digest
 *      matches the signed message, the signature recovers to the verifier
 *      address registered on chain — VALID.
 *   3. Carol receives a copy of the receipt. She tries to verify with HER
 *      pubkey. The digest is different (because buyer_pubkey is different),
 *      so signature recovery yields a DIFFERENT address — INVALID.
 *
 * The receipt is not transferable. The verifier signed an attestation
 * that names Alice, not Carol. No copy can change that without a new
 * signature from the verifier.
 *
 * Usage:
 *   defacts-verify <receipt.json>            # auto: use receipt's buyer_pubkey
 *   defacts-verify <receipt.json> --carol    # substitute Carol's pubkey
 *   defacts-verify <receipt.json> --pubkey 0x04...   # custom pubkey
 *
 * Designed for the demo's Act 5 ("Non-resale"). Holds INVALID on screen
 * for ~4 seconds with the recovered-vs-expected address comparison.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  keccak256,
  hashTypedData,
  recoverAddress,
  isAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ─── CLI parsing ────────────────────────────────────────────────────────

function usage() {
  console.error('Usage: defacts-verify <receipt.json> [--alice | --carol | --pubkey 0x04...]');
  console.error('');
  console.error('Examples:');
  console.error('  defacts-verify receipt.json                    # use buyer_pubkey from receipt');
  console.error('  defacts-verify receipt.json --carol            # substitute Carol\'s test pubkey');
  console.error('  defacts-verify receipt.json --pubkey 0x04abc...  # use custom pubkey');
  console.error('');
  console.error('--carol uses a hardcoded test keypair to demonstrate that a different');
  console.error('identity cannot verify the attestation. Real Carol would have her own.');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') usage();

const receiptPath = resolve(args[0]);
if (!existsSync(receiptPath)) {
  console.error(`File not found: ${receiptPath}`);
  process.exit(1);
}

let mode = 'alice';                   // default: use buyer_pubkey from receipt
let customPubkey = null;
for (let i = 1; i < args.length; i++) {
  if (args[i] === '--alice')  mode = 'alice';
  else if (args[i] === '--carol') mode = 'carol';
  else if (args[i] === '--pubkey') {
    mode = 'custom';
    customPubkey = args[++i];
    if (!customPubkey || !customPubkey.startsWith('0x')) {
      console.error('--pubkey requires 0x-prefixed hex value');
      process.exit(1);
    }
  } else {
    console.error(`Unknown arg: ${args[i]}`);
    usage();
  }
}

// ─── Load + parse receipt ───────────────────────────────────────────────

let receipt;
try {
  receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
} catch (e) {
  console.error(`Failed to parse receipt JSON: ${e.message}`);
  process.exit(1);
}

if (receipt.version !== 'defacts-receipt-v1') {
  console.error(`Unsupported receipt version: ${receipt.version}`);
  process.exit(1);
}

const att = receipt.verifier_attestation;
if (!att || att.tier !== 2) {
  console.error('Receipt has no Tier 2 attestation. This CLI only verifies Tier 2.');
  console.error('(Tier 1 attestations have no buyer-binding by design.)');
  process.exit(1);
}

const aliceP = att.buyer_pubkey;
const expectedVerifier = att.verifier_address;
const signature = att.signature;

// Hardcoded "Carol" private key for the --carol demo path. Generates a
// distinct, deterministic pubkey. This key has no funds and no role in
// the marketplace — it exists solely so the demo can show a concrete
// "different identity" scenario without the audience having to generate
// their own keypair.
const CAROL_TEST_PRIVKEY = '0x' + 'cc'.repeat(32);
const carolAccount = privateKeyToAccount(CAROL_TEST_PRIVKEY);
const carolPubkey = carolAccount.publicKey;

let buyerPubkey;
let buyerLabel;
if (mode === 'alice')        { buyerPubkey = aliceP;        buyerLabel = 'Alice (from receipt)'; }
else if (mode === 'carol')   { buyerPubkey = carolPubkey;   buyerLabel = 'Carol (test key)'; }
else                          { buyerPubkey = customPubkey;  buyerLabel = 'custom'; }

// ─── Reconstruct the EIP-712 typed data ─────────────────────────────────
//
// Must match verifier-stub/server.mjs Tier2Attestation type exactly.

const domain = {
  name: 'DeFacts',
  version: '1',
  chainId: receipt.metadata?.chain_id || 16602,
  verifyingContract: receipt.metadata?.escrow_addr ||
    process.env.ESCROW_ADDR ||
    '0xF49490aCd9c3Fb548c57BafF7034cD686827a641',
};

const types = {
  Tier2Attestation: [
    { name: 'psec_version', type: 'bytes32' },
    { name: 'model_commitment', type: 'bytes32' },
    { name: 'input_hash', type: 'bytes32' },
    { name: 'output_hash', type: 'bytes32' },
    { name: 'tier', type: 'uint8' },
    { name: 'buyer_pubkey', type: 'bytes' },
  ],
};

const message = {
  psec_version:     receipt.psec_version,
  model_commitment: receipt.model_commitment,
  input_hash:       att.input_hash,
  output_hash:      att.output_hash,
  tier:             2,
  buyer_pubkey:     buyerPubkey,    // ← the substitution point
};

// ─── Recover the signer ─────────────────────────────────────────────────

const digest = hashTypedData({ domain, types, primaryType: 'Tier2Attestation', message });
const recovered = await recoverAddress({ hash: digest, signature });

const aliceMatch = (mode === 'alice');
const verified = recovered.toLowerCase() === expectedVerifier.toLowerCase();

// ─── Render the result ──────────────────────────────────────────────────

const W = 70;
const line = '─'.repeat(W);
const heavyLine = '═'.repeat(W);

console.log('');
console.log(heavyLine);
console.log('  defacts-verify — Tier 2 receipt verification');
console.log(heavyLine);
console.log('');
console.log(`  Receipt:           ${receiptPath}`);
console.log(`  Trade ID:          ${receipt.trade_id}`);
console.log(`  Verifier (chain):  ${expectedVerifier}`);
console.log('');
console.log(`  Buyer pubkey for verification:`);
console.log(`    Mode:   ${buyerLabel}`);
console.log(`    Pubkey: ${buyerPubkey.slice(0, 26)}...${buyerPubkey.slice(-10)}`);
console.log('');
console.log(line);
console.log('');
console.log(`  EIP-712 digest:    ${digest}`);
console.log(`  Signature:         ${signature.slice(0, 26)}...${signature.slice(-10)}`);
console.log(`  Recovered signer:  ${recovered}`);
console.log(`  Expected (chain):  ${expectedVerifier}`);
console.log('');
console.log(line);
console.log('');

if (verified) {
  console.log('  ┌────────────────────────────────────────────────────┐');
  console.log('  │                                                    │');
  console.log('  │   ✓  V A L I D                                     │');
  console.log('  │                                                    │');
  console.log('  │   Recovered signer matches the on-chain verifier.  │');
  console.log('  │   This receipt is bound to the presented pubkey.   │');
  console.log('  │                                                    │');
  console.log('  └────────────────────────────────────────────────────┘');
  console.log('');
  process.exit(0);
} else {
  console.log('  ┌────────────────────────────────────────────────────┐');
  console.log('  │                                                    │');
  console.log('  │   ✗  I N V A L I D                                 │');
  console.log('  │                                                    │');
  console.log('  │   Recovered signer does NOT match the verifier.    │');
  console.log('  │   This pubkey did not sign the attestation.        │');
  console.log('  │                                                    │');
  console.log('  └────────────────────────────────────────────────────┘');
  console.log('');
  console.log(`  Why this happened:`);
  console.log(`    The verifier signed an attestation including the buyer's`);
  console.log(`    pubkey as a typed-data field. Substituting a different`);
  console.log(`    pubkey produces a different EIP-712 digest. The signature`);
  console.log(`    is bound to the original digest, so recovery yields a`);
  console.log(`    different (effectively random) address.`);
  console.log('');
  console.log(`  In the demo terms:`);
  console.log(`    Alice owns the receipt. Carol cannot verify it under her`);
  console.log(`    own identity, no matter how many copies she gets.`);
  console.log(`    Receipts are not transferable.`);
  console.log('');
  process.exit(1);
}
