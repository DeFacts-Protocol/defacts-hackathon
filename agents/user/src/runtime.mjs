/**
 * UserRuntime — buyer-side agent. Implements the marketplace state machine:
 *
 *   1. Broadcast defacts.query over AXL /send to discovered peers
 *   2. Collect defacts.bid envelopes via recvLoop for bidWindowMs
 *   3. Pick lowest-price bid (ignoring late arrivals)
 *   4. Send defacts.accept (with optional buyer_pubkey for Tier 2),
 *      receive defacts.deliver (with optional Tier 2 attestation)
 *   5. Call openTrade(...) on Escrow
 *   6. Call settleTier1(...), and if withTier2, settleTier2(...) in parallel
 *   7. Return trade ID + transaction hashes
 *   8. (if withTier2) Save final receipt JSON to disk for downstream tools
 *
 * Identity model: this runtime owns one AXL node (axlClient) and one
 * blockchain wallet. The buyer_pubkey for Tier 2 binding is derived from
 * WALLET_PRIVKEY at constructor time (single-keypair model). This means the
 * same identity that signs txs also binds the receipt — Carol-fails CLI
 * proves this by attempting to substitute Carol's pubkey at verify time.
 *
 * Tier 2 model: the supplier signs both Tier 1 and Tier 2 attestations
 * atomically and returns both in deliver. The buyer dispatches both settle
 * calls sequentially (nonce ordering) but waits for both receipts in
 * parallel. settleTier1 and settleTier2 are independent in the contract
 * (each has its own settled flag, neither gates the other).
 */

import { AxlClient } from '@defacts/axl-client';
import { PeerRegistry } from '@defacts/axl-client/peer-registry';
import { METHODS } from '@defacts/axl-client/methods';
import { ChainClient } from './chain.mjs';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class UserRuntime {
  constructor({
    axlApiBase,
    registryAddr,
    escrowAddr,
    rpcUrl,
    privateKey,
    proofFormat = 'stub-v1',
    bidWindowMs = 3000,
    deliveryTransport = 'send',
    deliveryTimeoutMs = 30000,
    receiptOutputDir,           // optional: where to write receipt JSON; defaults
                                //   to <cwd>/test/output/ if undefined
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
    this.receiptOutputDir = receiptOutputDir;

    // Derive buyer's secp256k1 identity from the wallet privkey.
    // viem's privateKeyToAccount exposes both compressed (33 bytes) and
    // uncompressed forms. We use the uncompressed pubkey for Tier 2 binding
    // because that's what the verifier-stub signs over. (See verifier-stub
    // tier2Types: buyer_pubkey is `bytes`.)
    const pkHex = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;
    const account = privateKeyToAccount(pkHex);
    // account.publicKey is uncompressed (65 bytes: 0x04 || X || Y)
    this.buyerAddress = account.address;
    this.buyerPubkey = account.publicKey;  // hex string with 0x prefix
  }

  /**
   * Run one full marketplace round-trip: query → bid → accept → settle.
   *
   * @param {object} args
   * @param {string} args.promptLabel
   * @param {number[]} args.inputTokenIds
   * @param {number} args.maxOutputTokens
   * @param {string} args.decoding
   * @param {string} args.budgetWei
   * @param {string} args.tier1AmountWei
   * @param {string} args.tier2AmountWei
   * @param {string} args.sellerAddr
   * @param {boolean} [args.withTier2=false]  — also settle Tier 2
   *
   * @returns {object} {
   *   tradeId, openTradeTx, settleTier1Tx, settleTier2Tx?, winningBid,
   *   deliver, receiptPath?
   * }
   */
  async queryMarket(args) {
    const required = ['promptLabel', 'inputTokenIds', 'maxOutputTokens', 'decoding',
                      'budgetWei', 'tier1AmountWei', 'tier2AmountWei', 'sellerAddr'];
    for (const k of required) {
      if (args[k] === undefined) throw new Error(`queryMarket: ${k} required`);
    }
    const withTier2 = !!args.withTier2;

    // Step 0: refresh peer registry from topology
    await this.peers.refresh();
    const peers = (await this.axl.getTopology()).peers || [];
    const peerPubkeys = peers.map((p) => p.public_key).filter(Boolean);
    if (peerPubkeys.length === 0) {
      throw new Error('queryMarket: no peers in AXL topology — start node B and let it peer');
    }

    // Step 1: send defacts.query
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

    // Step 2: collect bids
    const bids = [];
    this._bufferedEnvelopes = [];
    const stop = this.axl.recvLoop((msg) => {
      const env = msg.envelope;
      if (!env) return;
      if (env.method !== METHODS.BID) {
        this._bufferedEnvelopes.push(env);
        return;
      }
      if (env.params?.query_id !== queryId) return;
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

    // Step 3: pick winner (lowest in budget)
    const inBudget = bids.filter((b) => BigInt(b.priceWei) <= BigInt(args.budgetWei));
    if (inBudget.length === 0) {
      throw new Error(`queryMarket: no bids within budget ${args.budgetWei}, lowest was ${bids[0].priceWei}`);
    }
    inBudget.sort((x, y) => (BigInt(x.priceWei) < BigInt(y.priceWei) ? -1 : 1));
    const winner = inBudget[0];
    this._log('pick', `winning bid: agent_id=${winner.agentId} price=${winner.priceWei}`);

    // Step 4: send defacts.accept (include buyer_pubkey if Tier 2 wanted)
    const winnerPubkey = this.peers.resolveAgentId(winner.agentId);
    if (!winnerPubkey) {
      throw new Error(`queryMarket: cannot resolve agent_id=${winner.agentId} to AXL pubkey`);
    }

    const acceptParams = {
      query_id: queryId,
      bid_id: winner.envelope.id,
      agent_id: winner.agentId,
    };
    if (withTier2) {
      acceptParams.buyer_pubkey = this.buyerPubkey;
      acceptParams.with_tier2 = true;
    }

    let deliver;
    if (this.deliveryTransport === 'a2a') {
      deliver = await this.axl.a2aMethod(winnerPubkey, METHODS.ACCEPT, acceptParams,
        { timeoutMs: this.deliveryTimeoutMs });
    } else {
      await this.axl.sendGossip(winnerPubkey, METHODS.ACCEPT, acceptParams, queryId);
      this._log('accept', `sent accept via /send to agent_id=${winner.agentId}${withTier2 ? ' (with Tier 2)' : ''}`);
      deliver = await this._waitForDeliver(queryId, this.deliveryTimeoutMs);
    }

    if (!deliver || !deliver.receipt || !deliver.attestation) {
      throw new Error('queryMarket: deliver missing receipt or attestation');
    }
    if (withTier2 && !deliver.attestation_tier2) {
      throw new Error('queryMarket: Tier 2 requested but supplier did not return attestation_tier2');
    }
    this._log('deliver', `received receipt det_hash=${deliver.receipt.det_hash}` +
      (withTier2 ? ` + Tier2 sig=${deliver.attestation_tier2.signature.slice(0, 18)}...` : ''));

    // Step 5: openTrade on Escrow
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

    // Step 6: settle Tier 1 (and Tier 2 if requested).
    //
    // Both settleTier1 and settleTier2 are independent in the Escrow contract
    // — each has its own settled flag, neither gates the other. The Galileo
    // RPC, however, drops back-to-back tx broadcasts from the same wallet as
    // 'already known' (viem reports it as NonceTooLow). We therefore serialize
    // the two settles: settleTier1 fully confirms before settleTier2 dispatches.
    // This costs ~3 min of wall-clock on a congested testnet but is the only
    // pattern that survives viem's nonce manager racing itself.
    let settleTier1Tx, settleTier2Tx;
    settleTier1Tx = await this.chain.settleTier1({ tradeId, signature: a.signature });
    this._log('chain', `settleTier1 tx=${settleTier1Tx}`);

    if (withTier2) {
      const a2 = deliver.attestation_tier2;
      settleTier2Tx = await this.chain.settleTier2({
        tradeId,
        buyerPubkey: this.buyerPubkey,
        signature: a2.signature,
      });
      this._log('chain', `settleTier2 tx=${settleTier2Tx}`);
    }

    // Step 7: write final receipt JSON to disk if Tier 2 (Block 7 input)
    let receiptPath;
    if (withTier2) {
      receiptPath = this._writeReceiptJson({
        tradeId,
        receipt: r,
        attestation: a,
        attestationTier2: deliver.attestation_tier2,
        winner,
      });
      this._log('receipt', `wrote ${receiptPath}`);
    }

    return {
      tradeId, openTradeTx, settleTier1Tx,
      ...(withTier2 ? { settleTier2Tx, receiptPath } : {}),
      winningBid: winner, deliver,
    };
  }

  _writeReceiptJson({ tradeId, receipt, attestation, attestationTier2, winner }) {
    const dir = this.receiptOutputDir || (process.cwd() + '/test/output');
    mkdirSync(dir, { recursive: true });
    const path = `${dir}/receipt-${tradeId.slice(2, 14)}.json`;
    const out = {
      version: 'defacts-receipt-v1',
      trade_id: tradeId,
      psec_version: receipt.psec_version,
      model_commitment: receipt.model_commitment,
      input: {
        token_ids: receipt.input_token_ids,
      },
      output: {
        token_ids: receipt.output_token_ids,
      },
      det_hash: receipt.det_hash,
      proof_format: receipt.proof_format,
      proof_blob: receipt.proof_blob,
      verifier_attestation: {
        tier: 2,
        verifier_address: attestationTier2.verifier_address,
        buyer_pubkey: attestationTier2.buyer_pubkey,  // Alice's pubkey, NOT to be modified
        signature: attestationTier2.signature,
        signed_at: attestationTier2.signed_at,
        input_hash: attestation.input_hash,
        output_hash: attestation.output_hash,
      },
      // Also include Tier 1 attestation for completeness
      tier1_attestation: {
        tier: 1,
        verifier_address: attestation.verifier_address,
        signature: attestation.signature,
        signed_at: attestation.signed_at,
      },
      metadata: {
        seller_agent_id: winner.agentId,
        price_wei: winner.priceWei,
        proof_format: winner.proofFormat,
      },
    };
    writeFileSync(path, JSON.stringify(out, null, 2));
    return path;
  }

  async _waitForDeliver(queryId, timeoutMs) {
    if (Array.isArray(this._bufferedEnvelopes)) {
      const idx = this._bufferedEnvelopes.findIndex(
        (e) => e.method === METHODS.DELIVER && e.params?.query_id === queryId
      );
      if (idx !== -1) {
        const env = this._bufferedEnvelopes.splice(idx, 1)[0];
        return env.params;
      }
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const msg = await this.axl.recvGossip();
      if (msg && msg.envelope?.method === METHODS.DELIVER &&
          msg.envelope.params?.query_id === queryId) {
        return msg.envelope.params;
      }
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
