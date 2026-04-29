/**
 * CacheModeAgent — supplier runtime that bids when it has a pre-computed
 * receipt matching the buyer's prompt_label.
 *
 *   defacts.query → if cache hit, send defacts.bid (cheap price)
 *   defacts.accept → call verifier-stub for Tier 1 attestation, send
 *                    defacts.deliver with cached receipt + signature
 *
 * Does NOT touch the chain. The buyer drives all settlement; the agent
 * only provides receipts and signatures.
 *
 * Identity model: agent_id is application-layer (e.g., "cache-001",
 * "h100.defacts.eth"). One AXL node can host multiple agents under
 * different agent_ids; the buyer's PeerRegistry resolves agent_id back
 * to the AXL pubkey when sending accept.
 */

import { AxlClient, peerIdMatches } from '@defacts/axl-client';
import { gossipBuild } from '@defacts/axl-client/envelope';
import { METHODS } from '@defacts/axl-client/methods';
import { CacheStore } from './cache.mjs';

export class CacheModeAgent {
  constructor({
    axlApiBase,
    verifierUrl,
    agentId,
    priceWei,
    fixturesDir,
    proofFormat = 'stub-v1',
    ttlSeconds = 60,
  }) {
    if (!axlApiBase)  throw new Error('axlApiBase required');
    if (!verifierUrl) throw new Error('verifierUrl required');
    if (!agentId)     throw new Error('agentId required');
    if (!priceWei)    throw new Error('priceWei required');
    if (!fixturesDir) throw new Error('fixturesDir required');

    this.axl = new AxlClient({ apiBase: axlApiBase });
    this.cache = new CacheStore();
    this.verifierUrl = verifierUrl;
    this.agentId = agentId;
    this.priceWei = priceWei;
    this.fixturesDir = fixturesDir;
    this.proofFormat = proofFormat;
    this.ttlSeconds = ttlSeconds;

    // query_id → { senderPubkey, queryEnv } so deliver can route back to buyer
    this.inflight = new Map();
    this._stop = null;
  }

  async start() {
    const loaded = await this.cache.loadFromDir(this.fixturesDir);
    const ourPubkey = await this.axl.ourPublicKey();
    this._log('init',
      `agent_id=${this.agentId} pubkey=${ourPubkey.slice(0, 16)}... ` +
      `cache_size=${loaded} labels=[${this.cache.labels().slice(0, 3).join(', ')}${this.cache.size() > 3 ? ', ...' : ''}]`);

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
    const promptLabel = env.params.prompt_label;
    const proofFormat = env.params.proof_format;

    // Filter: do we have this receipt cached, in the right format?
    if (!this.cache.has(promptLabel)) {
      this._log('miss', `prompt_label="${promptLabel}" not in cache`);
      return;
    }
    if (proofFormat && proofFormat !== this.proofFormat) {
      this._log('skip', `proof_format=${proofFormat} unsupported (we serve ${this.proofFormat})`);
      return;
    }

    // Resolve sender pubkey from topology
    const topo = await this.axl.getTopology();
    const senderPubkey = (topo.peers || [])
      .map((p) => p.public_key)
      .find((pk) => pk && peerIdMatches(fromPeerId, pk));
    if (!senderPubkey) {
      this._log('error', `cannot resolve sender from topology, ignoring query_id=${queryId.slice(0, 10)}`);
      return;
    }

    const receipt = this.cache.get(promptLabel);
    const bidParams = {
      query_id: queryId,
      agent_id: this.agentId,
      price_wei: this.priceWei,
      receipt_cid: receipt.det_hash,    // cache identifier; in production this would be 0G Storage CID
      proof_format: this.proofFormat,
      ttl_seconds: this.ttlSeconds,
    };
    await this.axl.sendGossip(senderPubkey, METHODS.BID, bidParams, queryId);
    this._log('bid', `prompt_label="${promptLabel}" price=${this.priceWei} det_hash=${receipt.det_hash.slice(0, 18)}...`);

    // Remember the sender for the eventual deliver
    this.inflight.set(queryId, { senderPubkey, queryEnv: env });
  }

  async _handleAccept(env, fromPeerId) {
    const queryId = env.params.query_id;
    const ctx = this.inflight.get(queryId);
    if (!ctx) {
      this._log('warn', `accept for unknown query_id=${queryId.slice(0, 10)} (not ours, or expired)`);
      return;
    }
    if (env.params.agent_id !== this.agentId) {
      // Buyer accepted a different agent's bid; clean up
      this._log('lost', `accept routed to agent_id=${env.params.agent_id} (we are ${this.agentId})`);
      this.inflight.delete(queryId);
      return;
    }

    const promptLabel = ctx.queryEnv.params.prompt_label;
    const receipt = this.cache.get(promptLabel);
    if (!receipt) {
      this._log('error', `inflight query_id=${queryId.slice(0, 10)} but cache has no entry for ${promptLabel}`);
      this.inflight.delete(queryId);
      return;
    }

    // If the buyer requested Tier 2, they've supplied their pubkey in the
    // accept message. We sign BOTH attestations before delivering. If either
    // signing fails, we deliver nothing (atomic both-or-nothing).
    const wantTier2 = !!env.params.with_tier2;
    const buyerPubkey = env.params.buyer_pubkey;
    if (wantTier2 && !buyerPubkey) {
      this._log('error', `accept asked for Tier 2 but no buyer_pubkey provided`);
      this.inflight.delete(queryId);
      return;
    }

    let attestation, attestationTier2;
    try {
      // Tier 1
      const t1Res = await fetch(`${this.verifierUrl}/attest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ receipt, tier: 1 }),
      });
      if (!t1Res.ok) {
        const errBody = await t1Res.text();
        throw new Error(`Tier1 verifier failed: ${t1Res.status}: ${errBody}`);
      }
      attestation = await t1Res.json();
      this._log('attest', `Tier1 sig=${attestation.signature.slice(0, 18)}...`);

      // Tier 2 (only if requested)
      if (wantTier2) {
        const t2Res = await fetch(`${this.verifierUrl}/attest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ receipt, tier: 2, buyer_pubkey: buyerPubkey }),
        });
        if (!t2Res.ok) {
          const errBody = await t2Res.text();
          throw new Error(`Tier2 verifier failed: ${t2Res.status}: ${errBody}`);
        }
        attestationTier2 = await t2Res.json();
        this._log('attest', `Tier2 sig=${attestationTier2.signature.slice(0, 18)}... buyer_pubkey=${buyerPubkey.slice(0, 18)}...`);
      }
    } catch (e) {
      // Atomicity: if any attestation step failed, do NOT deliver a partial
      // receipt. The buyer will time out waiting for deliver and can retry.
      this._log('error', `attestation chain failed, no deliver: ${e.message}`);
      this.inflight.delete(queryId);
      return;
    }

    // Send deliver with both attestations (Tier 2 may be undefined)
    const deliverParams = { query_id: queryId, receipt, attestation };
    if (attestationTier2) deliverParams.attestation_tier2 = attestationTier2;
    await this.axl.sendGossip(ctx.senderPubkey, METHODS.DELIVER, deliverParams, queryId);
    this._log('deliver', `query_id=${queryId.slice(0, 10)}${attestationTier2 ? ' (with Tier 2)' : ''}`);

    this.inflight.delete(queryId);
  }

  _log(tag, msg) {
    if (process.env.CACHE_AGENT_QUIET) return;
    console.log(`[cache-agent ${tag}] ${msg}`);
  }
}
