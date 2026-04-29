/**
 * PeerRegistry — bridge between application-layer agent_id and
 * transport-layer AXL pubkey.
 *
 * AXL identifies peers by 64-hex ed25519 public keys. Our protocol identifies
 * agents by application-layer ids (e.g., "cache-001", "h100.defacts.eth").
 * Multiple agent runtimes can share an AXL node, so agent_id → AXL pubkey is
 * many-to-one in general (though typically 1:1 for the demo).
 *
 * Additionally, AXL's /recv X-From-Peer-Id is a Yggdrasil routing prefix
 * (see peerid.mjs) — not the full pubkey. The registry holds both directions:
 *
 *   byAgentId:    agent_id    → fullPubkey   (for sending /a2a or /send to)
 *   byRoutingId:  routingId   → fullPubkey   (for resolving incoming bids)
 *
 * Population sources:
 *   1. refresh()                — pulls /topology, indexes connected peers
 *      by routing prefix → full pubkey. Doesn't know agent_ids yet.
 *   2. registerFromBid(...)     — when a bid envelope arrives with a
 *      params.agent_id, binds that agent_id to the sender's AXL pubkey.
 *
 * Usage:
 *   const reg = new PeerRegistry(axlClient);
 *   await reg.refresh();                  // populates byRoutingId from /topology
 *
 *   // ... bid arrives via recvGossip ...
 *   reg.registerFromBid(envelope, fromPeerId);
 *
 *   const pubkey = reg.resolveAgentId('cache-001');
 *   await axlClient.a2aMethod(pubkey, 'defacts.accept', { ... });
 */

import { peerIdMatches, routingPrefix } from './peerid.mjs';

export class PeerRegistry {
  constructor(axlClient) {
    if (!axlClient) throw new Error('PeerRegistry: axlClient required');
    this.client = axlClient;
    this.byAgentId   = new Map();   // agent_id    → fullPubkey
    this.byRoutingId = new Map();   // routing prefix → fullPubkey
  }

  /**
   * Pull /topology from the AXL node, populate byRoutingId for each peer.
   * Call at startup and after any "where is X?" lookup miss to refresh.
   */
  async refresh() {
    const t = await this.client.getTopology();
    if (!Array.isArray(t.peers)) return;
    for (const peer of t.peers) {
      const pubkey = peer?.public_key;
      if (typeof pubkey !== 'string' || pubkey.length === 0) continue;
      // Map by full pubkey AND by stable routing prefix for incoming match
      this.byRoutingId.set(pubkey, pubkey);
      // Compute the routing prefix that AXL would use for this peer when
      // it sends to us. We don't actually know the prefix length AXL will
      // pick — it varies with routing tree depth — but we can store the
      // common 8-byte prefix as a lookup key.
      const eightBytePrefix = pubkey.slice(0, 16);
      this.byRoutingId.set(eightBytePrefix, pubkey);
    }
  }

  /**
   * Bind an agent_id to a full AXL pubkey based on an incoming envelope.
   *
   * fromPeerId is the X-From-Peer-Id from /recv (a routing prefix, NOT
   * the full pubkey). We need to resolve it back to a full pubkey from
   * the topology. If we can't, we record the routing prefix itself as
   * the address — sending back to it via /send will still work because
   * AXL accepts routing prefixes for delivery.
   */
  registerFromBid(envelope, fromPeerId) {
    const agentId = envelope?.params?.agent_id;
    if (typeof agentId !== 'string' || agentId.length === 0) {
      throw new Error('registerFromBid: envelope.params.agent_id required');
    }
    if (typeof fromPeerId !== 'string' || fromPeerId.length === 0) {
      throw new Error('registerFromBid: fromPeerId required');
    }

    // Try to resolve fromPeerId (routing prefix) to a full pubkey we know
    const fullPubkey = this._resolveRoutingId(fromPeerId);

    // Bind agent_id → AXL identity (full pubkey if known, else routing id)
    this.byAgentId.set(agentId, fullPubkey || fromPeerId);

    // Also index by the routing prefix so subsequent recv() events can
    // be attributed to this agent without re-resolving
    const prefix = routingPrefix(fromPeerId);
    if (prefix) this.byRoutingId.set(prefix, fullPubkey || fromPeerId);
  }

  /**
   * Returns full AXL pubkey for an agent_id, or undefined if unknown.
   * Caller uses this address with axlClient.a2aMethod() or .sendGossip().
   */
  resolveAgentId(agentId) {
    return this.byAgentId.get(agentId);
  }

  /**
   * Reverse lookup: given a routing prefix from /recv, find the full
   * pubkey if we know it. Falls back to topology peers list.
   */
  _resolveRoutingId(fromPeerId) {
    // Direct hit (we already saw this routing id)
    if (this.byRoutingId.has(fromPeerId)) return this.byRoutingId.get(fromPeerId);

    // Walk known full pubkeys, find one whose routing prefix matches
    for (const [key, value] of this.byRoutingId.entries()) {
      // value is always a full pubkey (or routing id if we never resolved it)
      if (value.length === 64 && peerIdMatches(fromPeerId, value)) {
        return value;
      }
    }
    return undefined;
  }

  /**
   * Returns all agent_ids currently registered.
   */
  knownAgents() {
    return Array.from(this.byAgentId.keys());
  }

  /**
   * Diagnostic: returns the full registry state for logging.
   */
  snapshot() {
    return {
      agents: Object.fromEntries(this.byAgentId),
      routes: Object.fromEntries(this.byRoutingId),
    };
  }
}
