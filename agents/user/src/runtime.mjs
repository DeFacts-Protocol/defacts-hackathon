/**
 * UserRuntime — buyer-side agent. Implements the marketplace state machine:
 *
 *   1. Broadcast defacts.query over AXL /send to discovered peers
 *   2. Collect defacts.bid envelopes via recvLoop for bidWindowMs
 *   3. Pick lowest-price bid (ignoring late arrivals)
 *   4. Send defacts.accept via /a2a, receive defacts.deliver synchronously
 *   5. Call openTrade(...) on Escrow with the deliver's receipt parameters
 *   6. Call settleTier1(...) on Escrow with the verifier's signature
 *   7. Return trade ID + transaction hashes
 *
 * Identity model: this runtime owns one AXL node (axlClient). Bid envelopes
 * carry params.agent_id; PeerRegistry maps agent_id → full AXL pubkey for
 * outgoing /a2a delivery.
 *
 * The runtime is intentionally stateless across queries — each queryMarket()
 * is independent. State lives in the chain (open trades) and the registry
 * (which agents are known).
 */

import { AxlClient } from '@defacts/axl-client';
import { PeerRegistry } from '@defacts/axl-client/peer-registry';
import { METHODS } from '@defacts/axl-client/methods';
import { ChainClient } from './chain.mjs';
import { randomBytes } from 'node:crypto';

export class UserRuntime {
  constructor({
    axlApiBase,
    registryAddr,
    escrowAddr,
    rpcUrl,
    privateKey,
    proofFormat = 'stub-v1',
    bidWindowMs = 3000,
    deliveryTransport = 'send',  // 'send' (gossip-based) or 'a2a' (sync RPC)
    deliveryTimeoutMs = 30000,
  }) {
    if (!axlApiBase)  throw new Error('axlApiBase required');
    if (!escrowAddr)  throw new Error('escrowAddr required');
    if (!rpcUrl)      throw new Error('rpcUrl required');
    if (!privateKey)  throw new Error('privateKey required');

    this.axl = new AxlClient({ apiBase: axlApiBase });
    this.peers = new PeerRegistry(this.axl);
    this.chain = new ChainClient({ escrowAddr, rpcUrl, privateKey });
    this.proofFormat = proofFormat;
    this.bidWindowMs = bidWindowMs;
    this.deliveryTransport = deliveryTransport;
    this.deliveryTimeoutMs = deliveryTimeoutMs;
  }

  /**
   * Run one full marketplace round-trip: query → bid → accept → settle.
   *
   * @param {object} args
   * @param {string} args.promptLabel       — human-readable prompt label
   * @param {number[]} args.inputTokenIds   — model-specific token IDs
   * @param {number} args.maxOutputTokens
   * @param {string} args.decoding          — 'greedy' | 'sampled'
   * @param {string} args.budgetWei         — decimal string, max willing to pay
   * @param {string} args.tier1AmountWei    — what to put in escrow tier 1
   * @param {string} args.tier2AmountWei    — what to put in escrow tier 2
   * @param {string} args.sellerAddr        — recipient of settled funds
   *
   * @returns {object} { tradeId, openTradeTx, settleTier1Tx, winningBid, deliver }
   */
  async queryMarket(args) {
    const required = ['promptLabel', 'inputTokenIds', 'maxOutputTokens', 'decoding',
                      'budgetWei', 'tier1AmountWei', 'tier2AmountWei', 'sellerAddr'];
    for (const k of required) {
      if (args[k] === undefined) throw new Error(`queryMarket: ${k} required`);
    }

    // Step 0: refresh peer registry from topology
    await this.peers.refresh();
    const ourPubkey = await this.axl.ourPublicKey();
    const peers = (await this.axl.getTopology()).peers || [];
    const peerPubkeys = peers.map((p) => p.public_key).filter(Boolean);
    if (peerPubkeys.length === 0) {
      throw new Error('queryMarket: no peers in AXL topology — start node B and let it peer');
    }

    // Step 1: send defacts.query to every connected peer
    const queryId = '0x' + Buffer.from(randomBytes(16)).toString('hex');
    const queryParams = {
      query_id: queryId,
      prompt_label: args.promptLabel,
      input_token_ids: args.inputTokenIds,
      max_output_tokens: args.maxOutputTokens,
      decoding: args.decoding,
      proof_format: this.proofFormat,
      budget_wei: args.budgetWei,
    };

    for (const pk of peerPubkeys) {
      await this.axl.sendGossip(pk, METHODS.QUERY, queryParams, queryId);
    }
    this._log('query', `sent defacts.query to ${peerPubkeys.length} peer(s), id=${queryId.slice(0, 10)}...`);

    // Step 2: collect bids for bidWindowMs.
    // Buffer any non-bid envelopes (e.g., a deliver that arrives during the
    // bid window) so a later phase can drain them.
    const bids = [];
    this._bufferedEnvelopes = [];
    const stop = this.axl.recvLoop((msg) => {
      const env = msg.envelope;
      if (!env) return;

      if (env.method !== METHODS.BID) {
        // Stash for later (e.g., DELIVER arriving during bid window)
        this._bufferedEnvelopes.push(env);
        return;
      }
      if (env.params?.query_id !== queryId) return;  // bid for a different query

      // Bind agent_id → pubkey for later /a2a addressing
      try { this.peers.registerFromBid(env, msg.fromPeerId); }
      catch (e) { this._log('warn', `bid registration failed: ${e.message}`); return; }

      bids.push({
        agentId: env.params.agent_id,
        priceWei: env.params.price_wei,
        receiptCid: env.params.receipt_cid,
        proofFormat: env.params.proof_format,
        ttlSeconds: env.params.ttl_seconds,
        envelope: env,
      });
      this._log('bid', `agent_id=${env.params.agent_id} price=${env.params.price_wei}`);
    }, { intervalMs: 100 });

    await sleep(this.bidWindowMs);
    stop();

    if (bids.length === 0) {
      throw new Error(`queryMarket: no bids received within ${this.bidWindowMs}ms`);
    }

    // Step 3: filter by budget, pick lowest price
    const inBudget = bids.filter((b) => BigInt(b.priceWei) <= BigInt(args.budgetWei));
    if (inBudget.length === 0) {
      throw new Error(`queryMarket: no bids within budget ${args.budgetWei}, lowest was ${bids[0].priceWei}`);
    }
    inBudget.sort((x, y) => (BigInt(x.priceWei) < BigInt(y.priceWei) ? -1 : 1));
    const winner = inBudget[0];
    this._log('pick', `winning bid: agent_id=${winner.agentId} price=${winner.priceWei}`);

    // Step 4: send defacts.accept via /a2a, receive defacts.deliver
    const winnerPubkey = this.peers.resolveAgentId(winner.agentId);
    if (!winnerPubkey) {
      throw new Error(`queryMarket: cannot resolve agent_id=${winner.agentId} to AXL pubkey`);
    }

    const acceptParams = {
      query_id: queryId,
      bid_id: winner.envelope.id,
      agent_id: winner.agentId,
    };

    let deliver;
    if (this.deliveryTransport === 'a2a') {
      // Production path: synchronous /a2a RPC (requires A2A backend on supplier)
      deliver = await this.axl.a2aMethod(winnerPubkey, METHODS.ACCEPT, acceptParams,
        { timeoutMs: this.deliveryTimeoutMs });
    } else {
      // Acceptance/test path: send accept via /send, poll /recv for deliver
      await this.axl.sendGossip(winnerPubkey, METHODS.ACCEPT, acceptParams, queryId);
      this._log('accept', `sent accept via /send to agent_id=${winner.agentId}`);
      deliver = await this._waitForDeliver(queryId, this.deliveryTimeoutMs);
    }

    if (!deliver || !deliver.receipt || !deliver.attestation) {
      throw new Error('queryMarket: deliver missing receipt or attestation');
    }
    this._log('deliver', `received receipt det_hash=${deliver.receipt.det_hash}`);

    // Step 5: call openTrade on Escrow
    const tradeId = '0x' + Buffer.from(randomBytes(32)).toString('hex');
    const r = deliver.receipt;
    const a = deliver.attestation;

    const openTradeTx = await this.chain.openTrade({
      tradeId,
      seller: args.sellerAddr,
      tier1Wei: args.tier1AmountWei,
      tier2Wei: args.tier2AmountWei,
      psecVersion: r.psec_version,
      modelCommitment: r.model_commitment,
      inputHash: a.input_hash,
      outputHash: a.output_hash,
      proofFormat: r.proof_format,
      valueWei: (BigInt(args.tier1AmountWei) + BigInt(args.tier2AmountWei)).toString(),
    });
    this._log('chain', `openTrade tx=${openTradeTx}`);

    // Step 6: call settleTier1 with verifier's signature.
    // viem's waitForTransactionReceipt in chain.mjs already waited for openTrade
    // to be mined before returning, so we can fire settleTier1 immediately.
    const settleTier1Tx = await this.chain.settleTier1({ tradeId, signature: a.signature });
    this._log('chain', `settleTier1 tx=${settleTier1Tx}`);

    return { tradeId, openTradeTx, settleTier1Tx, winningBid: winner, deliver };
  }

  async _waitForDeliver(queryId, timeoutMs) {
    // Check buffered envelopes first (deliver may have arrived during bid window)
    if (Array.isArray(this._bufferedEnvelopes)) {
      const idx = this._bufferedEnvelopes.findIndex(
        (e) => e.method === METHODS.DELIVER && e.params?.query_id === queryId
      );
      if (idx !== -1) {
        const env = this._bufferedEnvelopes.splice(idx, 1)[0];
        return env.params;
      }
    }

    // Otherwise poll AXL /recv until found or timeout
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await this.axl.recvGossip();
      if (msg && msg.envelope?.method === METHODS.DELIVER &&
          msg.envelope.params?.query_id === queryId) {
        return msg.envelope.params;
      }
      // Buffer anything else for potential future use
      if (msg?.envelope) {
        if (!Array.isArray(this._bufferedEnvelopes)) this._bufferedEnvelopes = [];
        this._bufferedEnvelopes.push(msg.envelope);
      }
      await sleep(100);
    }
    throw new Error(`_waitForDeliver: timed out after ${timeoutMs}ms for query_id=${queryId}`);
  }

  _log(tag, msg) {
    if (process.env.USER_RUNTIME_QUIET) return;
    console.log(`[user-runtime ${tag}] ${msg}`);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
