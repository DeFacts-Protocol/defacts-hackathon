// PD19 adapter — translates between the marketplace's /prove schema and a live
// PD19 /infer endpoint (typically running on RunPod).
//
// The marketplace's fresh-mode-agent expects /prove to return a receipt in the
// canonical PSEC shape: { det_hash, output_token_ids, proof_blob, proof_format,
// psec_version, model_commitment }. PD19 returns { answer, hash, deterministic,
// ... } for a string prompt.
//
// This adapter:
//   1. Maps known input_token_ids → prompt strings (canonical France for now)
//   2. Forwards to PD19's /infer endpoint
//   3. Pads PD19's 8-byte hash to a 32-byte 0x-prefixed hash (marketplace shape)
//   4. Returns the marketplace's expected response shape
//
// Why an adapter rather than modifying either side: production architecture
// keeps PD19's native API unchanged and adds protocol-specific adapters when
// needed. This prototypes that pattern. The fresh-mode-agent doesn't change.

import http from 'node:http';
import { URL } from 'node:url';

// ─── Config ────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '7011', 10);
const PD19_INFER_URL = process.env.PD19_INFER_URL || 'http://localhost:8000/infer';
const PD19_BACKEND_LABEL = process.env.PD19_BACKEND_LABEL || 'unknown'; // l4 / l40s / h100
const PROOF_FORMAT = process.env.PROOF_FORMAT || 'pd19-v1';

// ─── Canonical prompt mapping ──────────────────────────────────────────────
//
// The marketplace sends tokenized prompts; PD19 takes string prompts. For the
// hackathon, we hardcode the canonical France prompt. Production would use a
// real tokenizer here (or PD19 would accept tokens directly).
//
// input_token_ids [785, 6722, 315, 9625, 374] = "The capital of France is"

const CANONICAL_PROMPTS = {
  '785,6722,315,9625,374': 'The capital of France is',
};

function tokenIdsToPromptKey(tokenIds) {
  return tokenIds.join(',');
}

function lookupPrompt(tokenIds) {
  const key = tokenIdsToPromptKey(tokenIds);
  return CANONICAL_PROMPTS[key];
}

// ─── Hash padding ──────────────────────────────────────────────────────────
//
// PD19 returns 8-byte hashes (16 hex chars). The marketplace receipt schema
// and EIP-712 attestation use 32-byte hashes. Pad with zeros — the value is
// preserved, the wire format matches downstream expectations.

function padHashTo32Bytes(hash) {
  // Strip 0x prefix if present, lowercase
  const clean = hash.replace(/^0x/i, '').toLowerCase();
  if (clean.length === 64) {
    // Already 32 bytes
    return '0x' + clean;
  }
  if (clean.length === 16) {
    // 8-byte PD19 hash → pad with zeros to 32 bytes
    return '0x' + clean + '0'.repeat(48);
  }
  throw new Error(`unexpected hash length ${clean.length} (expected 16 or 64 hex chars): ${hash}`);
}

// ─── PD19 forward call ─────────────────────────────────────────────────────

async function callPD19(prompt, maxTokens) {
  const startMs = Date.now();
  const response = await fetch(PD19_INFER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, max_tokens: maxTokens }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`PD19 returned ${response.status}: ${text.slice(0, 200)}`);
  }

  const result = await response.json();
  const latencyMs = Date.now() - startMs;
  return { result, latencyMs };
}

// ─── Marketplace /prove handler ────────────────────────────────────────────

async function handleProve(body) {
  const {
    psec_version,
    model_commitment,
    input_token_ids,
    max_output_tokens,
    decoding,
  } = body;

  // Validate request shape
  if (!Array.isArray(input_token_ids)) {
    throw new Error('input_token_ids must be an array');
  }
  if (decoding !== 'greedy') {
    throw new Error(`unsupported decoding: ${decoding} (only 'greedy' supported)`);
  }

  // Map tokens to a known prompt
  const prompt = lookupPrompt(input_token_ids);
  if (!prompt) {
    throw new Error(
      `unknown input_token_ids sequence [${input_token_ids.slice(0, 5).join(',')}...] ` +
      `(adapter has canonical mappings only; production would tokenize directly)`
    );
  }

  // Forward to PD19
  const { result: pd19Result, latencyMs } = await callPD19(prompt, max_output_tokens);

  // Validate PD19's response
  if (!pd19Result.hash) {
    throw new Error(`PD19 response missing 'hash' field: ${JSON.stringify(pd19Result)}`);
  }
  if (pd19Result.deterministic === false) {
    throw new Error(`PD19 reported non-deterministic execution (hash_run1 != hash_run2)`);
  }

  // Translate to marketplace shape
  const detHash = padHashTo32Bytes(pd19Result.hash);

  return {
    psec_version,
    model_commitment,
    input_token_ids,
    output_token_ids: [], // marketplace doesn't verify token list, only hash
    det_hash: detHash,
    proof_blob: detHash, // hackathon stand-in; production carries real PD19 ZKP blob
    proof_format: PROOF_FORMAT,
    // Adapter metadata (helpful for debugging, ignored by marketplace)
    _adapter: {
      backend: PD19_BACKEND_LABEL,
      pd19_latency_ms: latencyMs,
      pd19_text_hash: pd19Result.text_hash,
      pd19_tokens_per_sec: pd19Result.tokens_per_sec,
      pd19_vram_used_gb: pd19Result.vram_used_gb,
    },
  };
}

// ─── HTTP server ───────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error(`invalid JSON body: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Health check
  if (url.pathname === '/health' && req.method === 'GET') {
    return send(res, 200, {
      ok: true,
      adapter: 'pd19-adapter',
      backend: PD19_BACKEND_LABEL,
      proof_format: PROOF_FORMAT,
      pd19_infer_url: PD19_INFER_URL,
      port: PORT,
    });
  }

  // Marketplace /prove
  if (url.pathname === '/prove' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const result = await handleProve(body);
      return send(res, 200, result);
    } catch (e) {
      console.error(`[adapter ${PD19_BACKEND_LABEL}] /prove failed:`, e.message);
      return send(res, 400, { error: e.message });
    }
  }

  return send(res, 404, { error: 'not found', path: url.pathname });
});

server.listen(PORT, () => {
  console.log(`[adapter ${PD19_BACKEND_LABEL}] listening on :${PORT} → ${PD19_INFER_URL} (proof_format=${PROOF_FORMAT})`);
});
