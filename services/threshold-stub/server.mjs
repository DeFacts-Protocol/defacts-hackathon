/**
 * DeFacts threshold-stub
 *
 * Port 7003. Endpoints: POST /wrap, POST /unwrap, GET /health.
 *
 * Purpose: gate the full Tier 2 receipt behind on-chain Tier2Settled payment.
 * In production this is a k-of-n committee (Lit Protocol or equivalent). In
 * the hackathon it's a single-party stub.
 *
 * Flow:
 *   1. Buyer sends Tier 2 payment on-chain (via Escrow.settleTier2).
 *   2. Threshold service sees the Tier2Settled event with matching trade_id.
 *   3. Buyer requests /wrap with their pubkey + payment_proof (trade_id).
 *   4. Threshold service confirms payment, ECIES-encrypts the receipt to buyer's pubkey.
 *   5. Returns the ciphertext blob. Only the buyer (holding the corresponding
 *      private key) can decrypt it client-side.
 *
 * For Day 2 development, payment_proof is a hardcoded boolean (the chain
 * watcher gets wired Day 4 when Escrow is deployed). The ECIES math is real
 * either way — that's what the acceptance test exercises.
 *
 * The /unwrap endpoint is a demo convenience that decrypts using a private
 * key supplied in the request. Real buyers NEVER send their private key over
 * the network — they decrypt client-side. /unwrap exists only so demo videos
 * can show the full round-trip in one screen.
 */

import express from 'express';
import { encrypt, decrypt, PrivateKey } from 'eciesjs';

const app = express();
app.use(express.json({ limit: '4mb' })); // bigger limit — receipts can include proof_blobs

const PORT = parseInt(process.env.PORT || '7003');

// In Day 4 mode, this gets wired to actually watch on-chain Tier2Settled
// events. Until then, /wrap accepts payment_proof = "stub-paid" as the
// hardcoded sentinel that means "trust me, the buyer paid."
const PAYMENT_WATCH_MODE = process.env.PAYMENT_WATCH_MODE || 'stub';

// In-memory log of trades the threshold service has seen. Production: this
// is reconstructed from chain events on startup; hackathon: it's just a
// dictionary populated as /wrap is called.
const TRADE_LOG = new Map();

function isPaymentValid(paymentProof) {
  if (PAYMENT_WATCH_MODE === 'stub') {
    // Day 2: hardcoded sentinel. Anything matching "stub-paid" passes.
    return paymentProof === 'stub-paid';
  }
  // Day 4: query chain for Tier2Settled event with this trade_id.
  // Not yet implemented — falls through to false, which is the safe default.
  return false;
}

// ─── Endpoints ────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({
    stub: true,
    port: PORT,
    payment_watch_mode: PAYMENT_WATCH_MODE,
    trades_known: TRADE_LOG.size,
  });
});

app.post('/wrap', (req, res) => {
  try {
    const { receipt, buyer_pubkey, payment_proof, trade_id } = req.body || {};

    if (!receipt) return res.status(400).json({ error: 'receipt required' });
    if (!buyer_pubkey) return res.status(400).json({ error: 'buyer_pubkey required' });
    if (!payment_proof) return res.status(400).json({ error: 'payment_proof required' });
    if (!trade_id) return res.status(400).json({ error: 'trade_id required' });

    if (!isPaymentValid(payment_proof)) {
      return res.status(402).json({
        error: 'payment_proof invalid',
        watch_mode: PAYMENT_WATCH_MODE,
        hint: PAYMENT_WATCH_MODE === 'stub'
          ? 'pass payment_proof="stub-paid" in dev mode'
          : 'on-chain Tier2Settled event for this trade_id not observed',
      });
    }

    // ECIES-encrypt the receipt to the buyer's pubkey.
    // eciesjs accepts compressed (33-byte) or uncompressed (65-byte) pubkeys
    // as 0x-prefixed hex or as a Buffer.
    const pubkeyBuf = Buffer.from(buyer_pubkey.replace(/^0x/, ''), 'hex');
    const plaintext = Buffer.from(JSON.stringify(receipt), 'utf8');
    const ciphertext = encrypt(pubkeyBuf, plaintext);

    TRADE_LOG.set(trade_id, {
      wrapped_at: Math.floor(Date.now() / 1000),
      buyer_pubkey,
      ciphertext_bytes: ciphertext.length,
    });

    res.json({
      trade_id,
      ciphertext: '0x' + ciphertext.toString('hex'),
      wrapped_at: Math.floor(Date.now() / 1000),
      buyer_pubkey,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/unwrap', (req, res) => {
  // DEMO CONVENIENCE ONLY. Real buyers never send their private key
  // over the network — they decrypt client-side using their wallet.
  // This exists so the demo video can show the full round-trip in one frame.
  try {
    const { ciphertext, buyer_privkey } = req.body || {};
    if (!ciphertext) return res.status(400).json({ error: 'ciphertext required' });
    if (!buyer_privkey) return res.status(400).json({ error: 'buyer_privkey required (demo only)' });

    const ctBytes = Buffer.from(ciphertext.replace(/^0x/, ''), 'hex');
    const skBytes = Buffer.from(buyer_privkey.replace(/^0x/, ''), 'hex');
    const plaintext = decrypt(skBytes, ctBytes);

    let receipt;
    try {
      receipt = JSON.parse(plaintext.toString('utf8'));
    } catch (_) {
      // Plaintext might not be JSON in some test cases; return raw text.
      return res.json({ plaintext: plaintext.toString('utf8') });
    }

    res.json({ receipt });
  } catch (err) {
    res.status(400).json({ error: 'decryption failed: ' + err.message });
  }
});

// Convenience for tests: derive an ECIES keypair so the acceptance script
// doesn't need to bake one in. Real buyers bring their own key.
app.post('/keypair-for-test', (_req, res) => {
  const sk = new PrivateKey();
  res.json({
    private_key: '0x' + Buffer.from(sk.secret).toString('hex'),
    public_key_compressed: '0x' + Buffer.from(sk.publicKey.compressed).toString('hex'),
    public_key_uncompressed: '0x' + Buffer.from(sk.publicKey.uncompressed).toString('hex'),
  });
});

app.listen(PORT, () => {
  console.log(`threshold-stub listening on :${PORT}`);
  console.log(`  GET  /health`);
  console.log(`  POST /wrap`);
  console.log(`  POST /unwrap          (demo convenience, never use in prod)`);
  console.log(`  POST /keypair-for-test (convenience for acceptance.sh)`);
  console.log(`  payment_watch_mode: ${PAYMENT_WATCH_MODE}`);
  if (PAYMENT_WATCH_MODE === 'stub') {
    console.log(`  Day 2 mode: payment_proof must be "stub-paid"`);
  }
});
