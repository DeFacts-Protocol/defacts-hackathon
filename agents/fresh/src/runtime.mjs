/**
 * FreshModeAgent — supplier runtime that produces FRESH receipts on each
 * query by calling a configured prover endpoint. Does NOT use a cache.
 *
 *   defacts.query → call prover at PROVER_ENDPOINT/prove with the query
 *                   params, get a receipt, send defacts.bid with that
 *                   receipt's det_hash as the CID
 *   defacts.accept → call verifier-stub for Tier 1 attestation, send
 *                    defacts.deliver with the (already-generated) receipt
 *                    + signature
 *
 * Configuration:
 *   PROVER_ENDPOINT=http://localhost:7001     for stub mode (Day 3)
 *   PROVER_ENDPOINT=https://l4.pd19.example   for live PD19 (Day 5)
 *
 * Same env-var fallback path: if PROVER_ENDPOINT points to a real PD19 box
 * and that box is down, voice-over swaps real → stub for the demo. Same
 * code, different endpoint.
 *
 * Pricing model: fresh-mode bids HIGHER than cache-mode because the
 * supplier is paying real GPU cost (or stub-equivalent latency) for each
 * query. The first buyer of a fresh receipt funds the computation; the
 * cache-mode-agent on the same prompt amortizes that cost across future
 * queries by selling the same receipt for a fraction.
 *
 * Performance note: fresh-mode-agent calls the prover BEFORE bidding so
 * that the bid carries a real det_hash. This means the bid window must
 * be wide enough to cover prover round-trip time. For the stub this is
 * <100ms; for live PD19 it can be 5-30s depending on the model size.
 * Bid window is set on the buyer side (UserRuntime.bidWindowMs); fresh
 * agents add their own latency to that.
 */

import { AxlClient, peerIdMatches } from '@defacts/axl-client';
import { METHODS } from '@defacts/axl-client/methods';

export class FreshModeAgent {
  constructor({
    axlApiBase,
    proverEndpoint,
    verifierUrl,
    agentId,
    priceWei,
    proofFormat = 'stub-v1',
    ttlSeconds = 60,
    psecVersion = '0x' + '11'.repeat(32),
    modelCommitment = '0x' + '22'.repeat(32),
  }) {
    if (!axlApiBase)     throw new Error('axlApiBase required');
    if (!proverEndpoint) throw new Error('proverEndpoint required');
    if (!verifierUrl)    throw new Error('verifierUrl required');
    if (!agentId)        throw new Error('agentId required');
    if (!priceWei)       throw new Error('priceWei required');

    this.axl = new AxlClient({ apiBase: axlApiBase });
    this.proverEndpoint = proverEndpoint.replace(/\/$/, '');
    this.verifierUrl = verifierUrl.replace(/\/$/, '');
    this.agentId = agentId;
    this.priceWei = priceWei;
    this.proofFormat = proofFormat;
    this.ttlSeconds = ttlSeconds;
    this.psecVersion = psecVersion;
    this.modelCommitment = modelCommitment;

    // query_id → { senderPubkey, queryEnv, receipt }
    // We hold the receipt across handler invocations because we generate it
    // at bid time (so the bid carries a real det_hash).
    this.inflight = new Map();
    this._stop = null;
  }

  async start() {
    const ourPubkey = await this.axl.ourPublicKey();
    this._log('init',
      `agent_id=${this.agentId} pubkey=${ourPubkey.slice(0, 16)}... ` +
      `prover=${this.proverEndpoint}`);

    this._stop = this.axl.recvLoop(async (msg) => {
      const env = msg.envelope;
      if (!env) return;
      try {
        if (env.method === METHODS.QUERY)        await this._handleQuery(env, msg.fromPeerId);
        else if (env.method === METHODS.ACCEPT)  await this._handleAccept(env, msg.fromPeerId);
      } catch (e) {
        this._log('error', `${env.method}: ${e.message}`);
      }
    }, { intervalMs: 100 });

    return this;
  }

  async stop() {
    if (this._stop) { this._stop(); this._stop = null; }
  }

  async _handleQuery(env, fromPeerId) {
    const queryId    = env.params.query_id;
    const proofFormat = env.params.proof_format;

    // Filter: only bid on proof_formats we serve
    if (proofFormat && proofFormat !== this.proofFormat) {
      this._log('skip', `proof_format=${proofFormat} unsupported (we serve ${this.proofFormat})`);
      return;
    }

    // Resolve sender pubkey
    const topo = await this.axl.getTopology();
    const senderPubkey = (topo.peers || [])
      .map((p) => p.public_key)
      .find((pk) => pk && peerIdMatches(fromPeerId, pk));
    if (!senderPubkey) {
      this._log('error', `cannot resolve sender from topology, ignoring query_id=${queryId.slice(0, 10)}`);
      return;
    }

    // Generate a fresh receipt by calling the prover endpoint.
    // This is the line that swaps stub → real PD19 by changing PROVER_ENDPOINT.
    let receipt;
    try {
      receipt = await this._callProver({
        psec_version:    this.psecVersion,
        model_commitment: this.modelCommitment,
        input_token_ids:  env.params.input_token_ids,
        max_output_tokens: env.params.max_output_tokens,
        decoding:          env.params.decoding,
      });
    } catch (e) {
      this._log('error', `prover failed for query_id=${queryId.slice(0, 10)}: ${e.message}`);
      return;
    }

    // Bid with the real det_hash from the just-generated receipt
    const bidParams = {
      query_id: queryId,
      agent_id: this.agentId,
      price_wei: this.priceWei,
      receipt_cid: receipt.det_hash,
      proof_format: this.proofFormat,
      ttl_seconds: this.ttlSeconds,
    };
    await this.axl.sendGossip(senderPubkey, METHODS.BID, bidParams, queryId);
    this._log('bid', `query_id=${queryId.slice(0, 10)} price=${this.priceWei} det_hash=${receipt.det_hash.slice(0, 18)}...`);

    // Hold the receipt for the deliver phase
    this.inflight.set(queryId, { senderPubkey, queryEnv: env, receipt });
  }

  async _handleAccept(env, fromPeerId) {
    const queryId = env.params.query_id;
    const ctx = this.inflight.get(queryId);
    if (!ctx) {
      this._log('warn', `accept for unknown query_id=${queryId.slice(0, 10)}`);
      return;
    }
    if (env.params.agent_id !== this.agentId) {
      this._log('lost', `accept routed to agent_id=${env.params.agent_id} (we are ${this.agentId})`);
      this.inflight.delete(queryId);
      return;
    }

    // If buyer requested Tier 2, get both attestations atomically
    const wantTier2 = !!env.params.with_tier2;
    const buyerPubkey = env.params.buyer_pubkey;
    if (wantTier2 && !buyerPubkey) {
      this._log('error', `accept asked for Tier 2 but no buyer_pubkey provided`);
      this.inflight.delete(queryId);
      return;
    }

    let attestation, attestationTier2;
    try {
      const t1Res = await fetch(`${this.verifierUrl}/attest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receipt: ctx.receipt, tier: 1 }),
      });
      if (!t1Res.ok) {
        const errBody = await t1Res.text();
        throw new Error(`Tier1 verifier failed: ${t1Res.status}: ${errBody}`);
      }
      attestation = await t1Res.json();
      this._log('attest', `Tier1 sig=${attestation.signature.slice(0, 18)}...`);

      if (wantTier2) {
        const t2Res = await fetch(`${this.verifierUrl}/attest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ receipt: ctx.receipt, tier: 2, buyer_pubkey: buyerPubkey }),
        });
        if (!t2Res.ok) {
          const errBody = await t2Res.text();
          throw new Error(`Tier2 verifier failed: ${t2Res.status}: ${errBody}`);
        }
        attestationTier2 = await t2Res.json();
        this._log('attest', `Tier2 sig=${attestationTier2.signature.slice(0, 18)}... buyer_pubkey=${buyerPubkey.slice(0, 18)}...`);
      }
    } catch (e) {
      this._log('error', `attestation chain failed, no deliver: ${e.message}`);
      this.inflight.delete(queryId);
      return;
    }

    const deliverParams = {
      query_id: queryId,
      receipt: ctx.receipt,
      attestation,
    };
    if (attestationTier2) deliverParams.attestation_tier2 = attestationTier2;
    await this.axl.sendGossip(ctx.senderPubkey, METHODS.DELIVER, deliverParams, queryId);
    this._log('deliver', `query_id=${queryId.slice(0, 10)}${attestationTier2 ? ' (with Tier 2)' : ''}`);

    this.inflight.delete(queryId);
  }

  async _callProver(proveBody) {
    const res = await fetch(`${this.proverEndpoint}/prove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(proveBody),
    });
    if (!res.ok) throw new Error(`prover ${this.proverEndpoint} returned ${res.status}`);
    const proverOut = await res.json();

    // Merge in input_token_ids — prover-stub doesn't echo them back, but
    // verifier-stub requires them in the receipt. Same merge pattern as
    // mock-supplier.mjs from Block 1.
    return {
      ...proverOut,
      input_token_ids: proveBody.input_token_ids,
    };
  }

  _log(tag, msg) {
    if (process.env.FRESH_AGENT_QUIET) return;
    console.log(`[fresh-agent ${tag}] ${msg}`);
  }
}
