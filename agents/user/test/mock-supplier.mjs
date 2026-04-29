/**
 * Mock supplier for user-runtime acceptance test.
 *
 * Sits on node B, runs as part of the acceptance test process.
 *
 * Behavior:
 *   - On defacts.query (via /recv on node B): respond with defacts.bid via /send back to sender
 *   - On defacts.accept: this would normally come via /a2a, but a2a requires
 *     the AXL backend to forward to a configured A2A server. For the
 *     acceptance test we work around this by:
 *       a) Mocking the /a2a path: the test instead sends a SECOND /send
 *          message with method=defacts.deliver in response to receiving the
 *          accept (one extra round-trip but uses transport we've validated)
 *
 * Real production: a2a flow is implemented in the cache-mode-agent and
 * fresh-mode-agent runtimes that come next.
 *
 * Because the mock is part of the test harness, it can call prover-stub
 * directly to get a real receipt, and verifier-stub to get a real attestation.
 */

import { AxlClient, peerIdMatches } from '@defacts/axl-client';
import { gossipBuild, gossipParse } from '@defacts/axl-client/envelope';
import { METHODS } from '@defacts/axl-client/methods';

const NODE_B_API     = process.env.NODE_B_API     || 'http://localhost:9202';
const PROVER_URL     = process.env.PROVER_URL     || 'http://localhost:7001';
const VERIFIER_URL   = process.env.VERIFIER_URL   || 'http://localhost:7002';
const AGENT_ID       = process.env.AGENT_ID       || 'mock-supplier-1';
const PRICE_WEI      = process.env.PRICE_WEI      || '100000000000000';     // 0.0001 0G
const QUIET          = !!process.env.MOCK_QUIET;

function log(tag, msg) { if (!QUIET) console.log(`[mock-supplier ${tag}] ${msg}`); }

const axl = new AxlClient({ apiBase: NODE_B_API });
const ourPubkey = await axl.ourPublicKey();
log('init', `ready agent_id=${AGENT_ID} pubkey=${ourPubkey.slice(0, 16)}...`);

// In-flight: track senders by query_id so we can route deliver back.
// Maps query_id -> { senderPubkey, queryEnvelope }
const inflight = new Map();

const stop = axl.recvLoop(async (msg) => {
  const env = msg.envelope;
  if (!env) {
    log('warn', 'received non-envelope bytes, ignoring');
    return;
  }

  if (env.method === METHODS.QUERY) {
    await handleQuery(env, msg.fromPeerId);
  } else if (env.method === METHODS.ACCEPT) {
    await handleAccept(env, msg.fromPeerId);
  } else {
    log('warn', `unhandled method: ${env.method}`);
  }
}, { intervalMs: 100 });

async function handleQuery(env, fromPeerId) {
  const queryId = env.params.query_id;
  log('query', `received query_id=${queryId.slice(0, 10)}... from ${fromPeerId.slice(0, 16)}...`);

  // Resolve sender pubkey from topology so we can reply
  const topo = await axl.getTopology();
  const senderPubkey = (topo.peers || [])
    .map((p) => p.public_key)
    .find((pk) => pk && peerIdMatches(fromPeerId, pk));
  if (!senderPubkey) {
    log('error', `could not resolve sender pubkey from topology, ignoring query`);
    return;
  }

  // Bid
  const bidParams = {
    query_id: queryId,
    agent_id: AGENT_ID,
    price_wei: PRICE_WEI,
    receipt_cid: '0x' + 'aa'.repeat(32),
    proof_format: env.params.proof_format,
    ttl_seconds: 60,
  };
  await axl.sendGossip(senderPubkey, METHODS.BID, bidParams, queryId);
  log('bid', `sent bid for query_id=${queryId.slice(0, 10)}... price=${PRICE_WEI}`);

  // Remember sender for the accept→deliver leg
  inflight.set(queryId, { senderPubkey, queryEnv: env });
}

async function handleAccept(env, fromPeerId) {
  const queryId = env.params.query_id;
  log('accept', `received accept for query_id=${queryId.slice(0, 10)}...`);

  const ctx = inflight.get(queryId);
  if (!ctx) {
    log('error', `no inflight context for query_id=${queryId}; cannot deliver`);
    return;
  }

  // Build a real receipt by calling prover-stub.
  // Prover-stub returns the output side of the receipt (det_hash, output_token_ids,
  // proof_blob, etc.) but doesn't echo back input_token_ids. We merge them in here
  // so the receipt is complete before sending to verifier-stub.
  const queryParams = ctx.queryEnv.params;
  const proveBody = {
    psec_version:    '0x' + '11'.repeat(32),
    model_commitment: '0x' + '22'.repeat(32),
    input_token_ids: queryParams.input_token_ids,
    max_output_tokens: queryParams.max_output_tokens,
    decoding: queryParams.decoding,
  };
  const proveRes = await fetch(`${PROVER_URL}/prove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(proveBody),
  });
  if (!proveRes.ok) throw new Error(`prover failed: ${proveRes.status}`);
  const proverOut = await proveRes.json();
  const receipt = {
    ...proverOut,
    input_token_ids: queryParams.input_token_ids,
  };
  log('prove', `receipt det_hash=${receipt.det_hash}`);

  // Get attestation(s). If buyer requested Tier 2, sign both atomically:
  // either both signatures succeed, or we abort without delivering anything.
  const wantTier2 = !!env.params.with_tier2;
  const buyerPubkey = env.params.buyer_pubkey;
  if (wantTier2 && !buyerPubkey) {
    log('error', `accept asked for Tier 2 but no buyer_pubkey provided`);
    return;
  }

  let attestation, attestationTier2;
  try {
    const t1Res = await fetch(`${VERIFIER_URL}/attest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receipt, tier: 1 }),
    });
    if (!t1Res.ok) {
      const err = await t1Res.text();
      throw new Error(`Tier1 verifier failed: ${t1Res.status}: ${err}`);
    }
    attestation = await t1Res.json();
    log('attest', `got Tier1 signature ${attestation.signature.slice(0, 18)}...`);

    if (wantTier2) {
      const t2Res = await fetch(`${VERIFIER_URL}/attest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receipt, tier: 2, buyer_pubkey: buyerPubkey }),
      });
      if (!t2Res.ok) {
        const err = await t2Res.text();
        throw new Error(`Tier2 verifier failed: ${t2Res.status}: ${err}`);
      }
      attestationTier2 = await t2Res.json();
      log('attest', `got Tier2 signature ${attestationTier2.signature.slice(0, 18)}... buyer=${buyerPubkey.slice(0, 18)}...`);
    }
  } catch (e) {
    log('error', `attestation chain failed, no deliver: ${e.message}`);
    return;
  }

  // Send deliver back to the buyer (with Tier 2 if requested)
  const deliverParams = {
    query_id: queryId,
    receipt,
    attestation,
  };
  if (attestationTier2) deliverParams.attestation_tier2 = attestationTier2;
  await axl.sendGossip(ctx.senderPubkey, METHODS.DELIVER, deliverParams, queryId);
  log('deliver', `sent deliver for query_id=${queryId.slice(0, 10)}...${attestationTier2 ? ' (with Tier 2)' : ''}`);

  inflight.delete(queryId);
}

// Keep alive
process.on('SIGINT',  () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });

// Print ready signal so the parent shell can wait for it
console.log('MOCK_SUPPLIER_READY');
