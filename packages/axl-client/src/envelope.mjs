/**
 * DeFacts gossip envelope format (for /send + /recv).
 *
 * AXL's /send takes raw bytes and /recv returns raw bytes. We wrap our
 * application messages in a JSON envelope so receivers can dispatch by
 * method name. The envelope is intentionally simple and human-readable.
 *
 *   {
 *     "v":      1,                            // envelope version
 *     "method": "defacts.query",              // dispatch key
 *     "id":     "0x...",                      // 32 hex chars, request correlation
 *     "params": { ... method-specific ... },
 *     "ts":     1730050000                    // unix seconds, optional
 *   }
 *
 * For /a2a/, AXL wraps OUR body in its own JSON-RPC-shaped transport envelope.
 * We send a JSON-RPC 2.0 body, AXL handles the wire-level framing. See
 * a2aBuildBody() / a2aParseResponse() below.
 */

import { randomBytes } from 'crypto';

export const ENVELOPE_VERSION = 1;

// ─── Gossip envelope (over /send) ────────────────────────────────────────

export function gossipBuild(method, params, id) {
  if (typeof method !== 'string' || !method) throw new Error('method required');
  const env = {
    v: ENVELOPE_VERSION,
    method,
    id: id || newId(),
    params: params ?? {},
    ts: Math.floor(Date.now() / 1000),
  };
  return Buffer.from(JSON.stringify(env), 'utf8');
}

export function gossipParse(bytes) {
  let env;
  try {
    env = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes);
  } catch (e) {
    throw new Error('gossip envelope: invalid JSON: ' + e.message);
  }
  if (typeof env !== 'object' || env === null) throw new Error('gossip envelope: not an object');
  if (typeof env.method !== 'string') throw new Error('gossip envelope: missing method');
  if (typeof env.id !== 'string')     throw new Error('gossip envelope: missing id');
  if (env.v !== ENVELOPE_VERSION) throw new Error('gossip envelope: unsupported version ' + env.v);
  return env;
}

// ─── A2A body (JSON-RPC 2.0 over /a2a/) ─────────────────────────────────

export function a2aBuildBody(method, params, id) {
  // AXL's /a2a expects JSON-RPC 2.0 in the body. AXL wraps it in its own
  // transport envelope ({a2a: true, request: <our body>}) on the wire.
  // The peer's A2A handler sees AXL's envelope and unwraps it.
  return JSON.stringify({
    jsonrpc: '2.0',
    method,
    params: params ?? {},
    id: id || newId(),
  });
}

export function a2aParseResponse(text) {
  let resp;
  try {
    resp = JSON.parse(text);
  } catch (e) {
    throw new Error('a2a response: invalid JSON: ' + e.message);
  }
  if (resp.error) {
    const err = new Error('a2a peer error: ' + (resp.error.message || JSON.stringify(resp.error)));
    err.code = resp.error.code;
    err.data = resp.error.data;
    throw err;
  }
  return resp.result;
}

// ─── ID generator ──────────────────────────────────────────────────────

export function newId() {
  return '0x' + randomBytes(16).toString('hex');
}
