/**
 * DeFacts verifier-stub
 *
 * Port 7002. Endpoints: POST /attest, GET /health, GET /address.
 *
 * Flow for /attest:
 *   1. Receive a receipt from a buyer or agent.
 *   2. Forward to prover-stub's /verify to confirm the det_hash matches.
 *   3. If valid, build the EIP-712 typed message (Tier1 or Tier2).
 *   4. Sign with the verifier's private key.
 *   5. Return { verifier_address, signature, signed_at }.
 *
 * The signature recovers (via ECDSA.recover in Escrow.sol) to the verifier's
 * registered address. That's how the on-chain Escrow validates that this
 * verifier signed the attestation.
 *
 * The verifier-stub holds a secp256k1 private key in VERIFIER_PRIVKEY env var.
 * Its address gets registered in VerifierRegistry under proof_format=stub-v1
 * via `cast send VerifierRegistry register("stub-v1", <verifier_address>)`.
 *
 * IMPORTANT: this verifier ONLY validates proof_format=stub-v1. The pd19-v1
 * verifier is a separate service (Day 4) with its own key and registration.
 */

import express from 'express';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, encodeAbiParameters, encodePacked, toBytes } from 'viem';

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = parseInt(process.env.PORT || '7002');
const PROOF_FORMAT = 'stub-v1';
const PROVER_ENDPOINT = process.env.PROVER_ENDPOINT || 'http://localhost:7001';
const ESCROW_ADDR = (process.env.ESCROW_ADDR || '0x0000000000000000000000000000000000000001');
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '16602');

// Required: VERIFIER_PRIVKEY (0x-prefixed 32-byte hex). No default — fail loud
// if missing rather than silently using a known key.
if (!process.env.VERIFIER_PRIVKEY) {
  console.error('FATAL: VERIFIER_PRIVKEY env var required. Set it to a 0x-prefixed 32-byte secp256k1 private key.');
  console.error('Generate one with: openssl rand -hex 32');
  process.exit(1);
}
const VERIFIER_PRIVKEY = process.env.VERIFIER_PRIVKEY;
const account = privateKeyToAccount(VERIFIER_PRIVKEY);

const domain = {
  name: 'DeFacts',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract: ESCROW_ADDR,
};

const tier1Types = {
  Tier1Attestation: [
    { name: 'psec_version', type: 'bytes32' },
    { name: 'model_commitment', type: 'bytes32' },
    { name: 'input_hash', type: 'bytes32' },
    { name: 'output_hash', type: 'bytes32' },
    { name: 'tier', type: 'uint8' },
  ],
};

const tier2Types = {
  Tier2Attestation: [
    { name: 'psec_version', type: 'bytes32' },
    { name: 'model_commitment', type: 'bytes32' },
    { name: 'input_hash', type: 'bytes32' },
    { name: 'output_hash', type: 'bytes32' },
    { name: 'tier', type: 'uint8' },
    { name: 'buyer_pubkey', type: 'bytes' },
  ],
};

// ─── Hash helpers (must match prover-stub and Escrow.sol exactly) ────────

function packU32BE(ids) {
  const buf = Buffer.alloc(ids.length * 4);
  ids.forEach((id, i) => buf.writeUInt32BE(id >>> 0, i * 4));
  return ('0x' + buf.toString('hex'));
}

function tokenArrayHash(tokenIds) {
  // Matches resolved [CONFIRM:] block #5 in spec/receipt-format.md §6:
  // hash := keccak256( concat( big_endian_uint32(id_i) for id_i in token_ids ) )
  return keccak256(packU32BE(tokenIds));
}

// ─── Endpoints ────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    stub: true,
    proof_format: PROOF_FORMAT,
    port: PORT,
    verifier_address: account.address,
    chain_id: CHAIN_ID,
    escrow_addr: ESCROW_ADDR,
    prover_endpoint: PROVER_ENDPOINT,
  });
});

app.get('/address', (_req, res) => {
  // Convenience for `cast send VerifierRegistry.register(...)` scripts
  res.json({ verifier_address: account.address });
});

app.post('/attest', async (req, res) => {
  try {
    const { receipt, tier, buyer_pubkey } = req.body || {};

    if (!receipt) return res.status(400).json({ valid: false, reason: 'receipt required' });
    if (tier !== 1 && tier !== 2) return res.status(400).json({ valid: false, reason: 'tier must be 1 or 2' });
    if (tier === 2 && !buyer_pubkey) return res.status(400).json({ valid: false, reason: 'buyer_pubkey required for tier 2' });

    // Required receipt fields
    const requiredFields = ['psec_version', 'model_commitment', 'input_token_ids', 'output_token_ids', 'det_hash', 'proof_format'];
    for (const f of requiredFields) {
      if (receipt[f] === undefined) return res.status(400).json({ valid: false, reason: `receipt.${f} required` });
    }

    if (receipt.proof_format !== PROOF_FORMAT) {
      return res.status(400).json({ valid: false, reason: `verifier-stub only handles proof_format=${PROOF_FORMAT}, got ${receipt.proof_format}` });
    }

    // Step 1: validate the receipt's det_hash via prover-stub.
    // The verifier does NOT blindly trust the receipt — it asks the prover
    // (or recomputes) to confirm the hash is correct for the given inputs.
    const verifyResp = await fetch(`${PROVER_ENDPOINT}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        psec_version: receipt.psec_version,
        model_commitment: receipt.model_commitment,
        input_token_ids: receipt.input_token_ids,
        output_token_ids: receipt.output_token_ids,
        det_hash: receipt.det_hash,
        proof_format: receipt.proof_format,
      }),
    });

    if (!verifyResp.ok) {
      return res.status(502).json({ valid: false, reason: `prover unreachable: ${verifyResp.status}` });
    }
    const verifyResult = await verifyResp.json();
    if (!verifyResult.valid) {
      return res.status(400).json({ valid: false, reason: 'receipt det_hash invalid', prover_response: verifyResult });
    }

    // Step 2: compute input_hash and output_hash per spec/receipt-format.md §6
    const inputHash = tokenArrayHash(receipt.input_token_ids);
    const outputHash = tokenArrayHash(receipt.output_token_ids);

    // Step 3: build typed message and sign
    if (tier === 1) {
      const message = {
        psec_version: receipt.psec_version,
        model_commitment: receipt.model_commitment,
        input_hash: inputHash,
        output_hash: outputHash,
        tier: 1,
      };
      const signature = await account.signTypedData({
        domain, types: tier1Types, primaryType: 'Tier1Attestation', message,
      });
      return res.json({
        valid: true,
        verifier_address: account.address,
        signature,
        signed_at: Math.floor(Date.now() / 1000),
        tier: 1,
        input_hash: inputHash,
        output_hash: outputHash,
      });
    } else {
      // Tier 2: include buyer_pubkey. The dynamic-bytes substitution is
      // handled automatically by viem when type: 'bytes' is declared.
      const message = {
        psec_version: receipt.psec_version,
        model_commitment: receipt.model_commitment,
        input_hash: inputHash,
        output_hash: outputHash,
        tier: 2,
        buyer_pubkey,
      };
      const signature = await account.signTypedData({
        domain, types: tier2Types, primaryType: 'Tier2Attestation', message,
      });
      return res.json({
        valid: true,
        verifier_address: account.address,
        signature,
        signed_at: Math.floor(Date.now() / 1000),
        tier: 2,
        input_hash: inputHash,
        output_hash: outputHash,
        buyer_pubkey,
      });
    }
  } catch (err) {
    return res.status(500).json({ valid: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`verifier-stub listening on :${PORT}`);
  console.log(`  GET  /health`);
  console.log(`  GET  /address`);
  console.log(`  POST /attest`);
  console.log(`  proof_format    : ${PROOF_FORMAT}`);
  console.log(`  verifier address: ${account.address}`);
  console.log(`  chain_id        : ${CHAIN_ID}`);
  console.log(`  escrow_addr     : ${ESCROW_ADDR}`);
  console.log(`  prover_endpoint : ${PROVER_ENDPOINT}`);
});
