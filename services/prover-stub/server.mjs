/**
 * DeFacts prover-stub
 * Port 7001. Endpoints: POST /prove, POST /verify, GET /health.
 *
 * det_hash := sha256( psec_version || model_commitment || u32be(input_ids) || u32be(output_ids) )
 * proof_format: "stub-v1" — deliberately different from real PSEC.
 *
 * The proof_format tag means the on-chain VerifierRegistry routes stub
 * receipts to stub.verifier.defacts.eth, never to pd19.verifier.defacts.eth.
 * Stubs and PD19 receipts do not collide.
 */

import express from 'express';
import { createHash } from 'crypto';

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = 7001;
const PROOF_FORMAT = 'stub-v1';

// ─── Canonical canned outputs (Qwen 2.5 14B Instruct, BF16, greedy) ──────
// Keys: stringified input_token_ids (CSV). Values: 20-token greedy continuation.

const CANNED_OUTPUTS = {
  // "The capital of France is" -> "Paris..."
  '785,6722,315,9625,374': [12095, 13, 576, 6722, 315, 17689, 374, 24081, 13, 576, 6722, 315, 15344, 374, 21718, 13, 576, 6722, 315, 9856],
  // "What is 2 + 2?" -> "4..."
  '3838,374,220,17,488,220,17,30': [19, 13, 576, 4226, 374, 220, 19, 13, 1096, 374, 264, 6770, 34784, 3405, 448, 264, 30339, 4226, 13, 576],
  // "Who wrote Hamlet?" -> "William Shakespeare..."
  '15191,6139,21071,30': [9747, 38968, 6139, 21071, 13, 576, 1486, 572, 5326, 2163, 220, 16, 21, 15, 15, 13, 1084, 374, 825, 315],
};

// Default fallback for unknown prompts.
const DEFAULT_OUTPUT = [40, 4157, 1492, 448, 429, 3405, 1576, 432, 374, 537, 949, 315, 847, 19259, 35427, 9293, 13, 1416, 498, 1184];

function packU32BE(ids) {
  const buf = Buffer.alloc(ids.length * 4);
  ids.forEach((id, i) => buf.writeUInt32BE(id >>> 0, i * 4));
  return buf;
}

function hexToBuffer(hex0x) {
  if (typeof hex0x !== 'string') throw new Error('hex must be a string');
  const s = hex0x.startsWith('0x') ? hex0x.slice(2) : hex0x;
  if (s.length === 0 || s.length % 2 !== 0) throw new Error('invalid hex length: ' + hex0x);
  return Buffer.from(s, 'hex');
}

function computeStubHash(psecVersion, modelCommitment, inputIds, outputIds) {
  const h = createHash('sha256');
  h.update(hexToBuffer(psecVersion));
  h.update(hexToBuffer(modelCommitment));
  h.update(packU32BE(inputIds));
  h.update(packU32BE(outputIds));
  return '0x' + h.digest('hex');
}

app.get('/health', (_req, res) => {
  res.json({ stub: true, proof_format: PROOF_FORMAT, port: PORT });
});

app.post('/prove', (req, res) => {
  try {
    const { psec_version, model_commitment, input_token_ids, max_output_tokens, decoding } = req.body || {};
    if (!psec_version) return res.status(400).json({ error: 'psec_version required (0x-hex)' });
    if (!model_commitment) return res.status(400).json({ error: 'model_commitment required (0x-hex)' });
    if (!Array.isArray(input_token_ids)) return res.status(400).json({ error: 'input_token_ids must be array of uint32' });
    if (decoding && decoding !== 'greedy') return res.status(400).json({ error: 'only decoding=greedy supported in stub' });

    const max = Math.max(1, Math.min(parseInt(max_output_tokens) || 20, 20));
    const key = input_token_ids.join(',');
    const fullOutput = CANNED_OUTPUTS[key] || DEFAULT_OUTPUT;
    const outputIds = fullOutput.slice(0, max);
    const detHash = computeStubHash(psec_version, model_commitment, input_token_ids, outputIds);

    res.json({
      output_token_ids: outputIds,
      det_hash: detHash,
      proof_blob: detHash,
      proof_format: PROOF_FORMAT,
      psec_version,
      model_commitment,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/verify', (req, res) => {
  try {
    const { psec_version, model_commitment, input_token_ids, output_token_ids, det_hash, proof_format } = req.body || {};
    if (proof_format && proof_format !== PROOF_FORMAT) {
      return res.status(400).json({ valid: false, reason: 'prover-stub only verifies proof_format=' + PROOF_FORMAT });
    }
    const recomputed = computeStubHash(psec_version, model_commitment, input_token_ids, output_token_ids);
    res.json({
      valid: recomputed === det_hash,
      method: PROOF_FORMAT,
      recomputed_hash: recomputed,
      received_hash: det_hash,
    });
  } catch (err) {
    res.status(400).json({ valid: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('prover-stub listening on :' + PORT);
  console.log('  GET  /health');
  console.log('  POST /prove');
  console.log('  POST /verify');
  console.log('  proof_format: ' + PROOF_FORMAT);
});
