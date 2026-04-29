/**
 * AxlClient — HTTP wrapper around an AXL node's local API.
 *
 * One client instance per AXL node. Default API base is http://localhost:9201
 * (matches DeFacts node-a config); pass apiBase to override.
 *
 *   const client = new AxlClient({ apiBase: 'http://localhost:9201' });
 *   const me = await client.getTopology();
 *   await client.send(peerPubKey, gossipBuild('defacts.query', { ... }));
 *   const incoming = await client.recv();
 *
 * Methods:
 *   getTopology()       — { our_public_key, peers, our_ipv6, tree }
 *   send(toPeerId, bytes)              — POST /send, fire-and-forget
 *   recv()              — GET /recv → { fromPeerId, bytes } | null
 *   recvLoop(handler, opts)   — long-poll loop, calls handler(message)
 *   a2a(toPeerId, body, opts)  — POST /a2a/{peer_id}, sync request/response
 *
 * Envelope construction is in envelope.mjs — keep this file transport-only.
 */

import { gossipBuild, gossipParse, a2aBuildBody, a2aParseResponse } from './envelope.mjs';
export { peerIdMatches, routingPrefix } from './peerid.mjs';

export class AxlClient {
  constructor({ apiBase = 'http://localhost:9201', defaultTimeoutMs = 5000 } = {}) {
    this.apiBase = apiBase.replace(/\/$/, '');
    this.defaultTimeoutMs = defaultTimeoutMs;
    this._ourPublicKey = null;
  }

  async getTopology() {
    const r = await this._fetch('/topology', { method: 'GET' });
    if (!r.ok) throw new Error('topology: HTTP ' + r.status);
    return r.json();
  }

  async ourPublicKey() {
    if (this._ourPublicKey) return this._ourPublicKey;
    const t = await this.getTopology();
    if (!t.our_public_key) throw new Error('topology missing our_public_key');
    this._ourPublicKey = t.our_public_key;
    return this._ourPublicKey;
  }

  // ─── /send: fire-and-forget bytes to a peer ────────────────────────

  async send(toPeerId, bytes) {
    if (typeof toPeerId !== 'string' || toPeerId.length === 0) {
      throw new Error('send: toPeerId required');
    }
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
      throw new Error('send: bytes must be Buffer or Uint8Array');
    }
    const r = await this._fetch('/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Destination-Peer-Id': toPeerId,
      },
      body: bytes,
    });
    if (!r.ok) throw new Error('send: HTTP ' + r.status + ' ' + (await r.text()));
    return { sentBytes: parseInt(r.headers.get('x-sent-bytes') || '0', 10) };
  }

  async sendGossip(toPeerId, method, params, id) {
    return this.send(toPeerId, gossipBuild(method, params, id));
  }

  // ─── /recv: dequeue one message from the receive queue ────────────

  async recv() {
    const r = await this._fetch('/recv', { method: 'GET' });
    if (r.status === 204) return null;
    if (!r.ok) throw new Error('recv: HTTP ' + r.status);
    const fromPeerId = r.headers.get('x-from-peer-id');
    const buf = Buffer.from(await r.arrayBuffer());
    return { fromPeerId, bytes: buf };
  }

  async recvGossip() {
    const msg = await this.recv();
    if (!msg) return null;
    try {
      const env = gossipParse(msg.bytes);
      return { fromPeerId: msg.fromPeerId, envelope: env };
    } catch (e) {
      // Not a DeFacts gossip envelope (could be stray bytes, MCP, A2A
      // residue, etc). Return the raw bytes so callers can decide.
      return { fromPeerId: msg.fromPeerId, bytes: msg.bytes, parseError: e.message };
    }
  }

  /**
   * Long-poll /recv at intervalMs. handler receives parsed gossip messages
   * (or raw bytes if parse failed). Returns a stop function.
   *
   * Usage:
   *   const stop = client.recvLoop((msg) => { ... });
   *   ...later...
   *   stop();
   */
  recvLoop(handler, { intervalMs = 250 } = {}) {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        const msg = await this.recvGossip();
        if (msg) {
          try { await handler(msg); } catch (e) { console.error('recvLoop handler error:', e); }
        }
      } catch (e) {
        // Network blip; ignore and continue
        console.error('recvLoop fetch error:', e.message);
      }
      setTimeout(tick, intervalMs);
    };
    setTimeout(tick, 0);
    return () => { stopped = true; };
  }

  // ─── /a2a/{peer_id}: synchronous request/response ─────────────────

  async a2a(toPeerId, jsonRpcBody, { timeoutMs } = {}) {
    if (typeof toPeerId !== 'string' || toPeerId.length === 0) {
      throw new Error('a2a: toPeerId required');
    }
    const body = typeof jsonRpcBody === 'string' ? jsonRpcBody : JSON.stringify(jsonRpcBody);
    const r = await this._fetch('/a2a/' + toPeerId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      timeoutMs: timeoutMs ?? 30000,
    });
    if (!r.ok) {
      const errBody = await r.text();
      throw new Error('a2a: HTTP ' + r.status + ' ' + errBody);
    }
    const text = await r.text();
    return a2aParseResponse(text);
  }

  async a2aMethod(toPeerId, method, params, opts = {}) {
    return this.a2a(toPeerId, a2aBuildBody(method, params, opts.id), opts);
  }

  // ─── Internal: fetch with timeout ─────────────────────────────────

  async _fetch(path, { method = 'GET', headers = {}, body, timeoutMs } = {}) {
    const controller = new AbortController();
    const t = timeoutMs ?? this.defaultTimeoutMs;
    const timer = setTimeout(() => controller.abort(), t);
    try {
      return await fetch(this.apiBase + path, {
        method, headers, body, signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
