/**
 * PeerRegistry unit tests.
 *
 * Run from packages/axl-client/ with:
 *   node test/peer-registry-test.mjs
 *
 * No external dependencies — uses a stub AxlClient.
 */

import { PeerRegistry } from '../src/peer-registry.mjs';

// Real values from tonight's AXL acceptance run
const PUBKEY_A = 'c9d42d0afc803e5a75ea6de8df7aeca35230228bb00acd1fb29875d1790f7021';
const PUBKEY_B = '46da0cac2173a8d36954813d5e5617abdf76cbf51bde02264698d855428ee211';

// X-From-Peer-Id as observed from real /recv (B sending → A receiving)
const ROUTING_ID_B = '46da0cac2173a8d36954813d5e563fffffffffffffffffffffffffffffffffff';

// Stub AXL client — implements just .getTopology()
class StubAxlClient {
  constructor(topo) { this.topo = topo; }
  async getTopology() { return this.topo; }
}

let pass = 0, fail = 0;
function expect(label, cond, detail) {
  if (cond) { pass++; console.log(`✓ ${label}`); }
  else      { fail++; console.error(`✗ ${label}`, detail || ''); }
}
async function asyncExpect(label, fn) {
  try {
    const ok = await fn();
    if (ok) { pass++; console.log(`✓ ${label}`); }
    else    { fail++; console.error(`✗ ${label}`); }
  } catch (e) {
    fail++; console.error(`✗ ${label}: threw`, e.message);
  }
}

// ─── Test 1: refresh populates byRoutingId from topology ────────────────

{
  const stub = new StubAxlClient({
    our_public_key: PUBKEY_A,
    peers: [{ public_key: PUBKEY_B, uri: 'tls://127.0.0.1:33158' }],
  });
  const reg = new PeerRegistry(stub);
  await reg.refresh();

  expect('refresh: byRoutingId has full pubkey entry',
    reg._resolveRoutingId(PUBKEY_B) === PUBKEY_B);

  expect('refresh: byRoutingId has 8-byte prefix entry',
    reg._resolveRoutingId(PUBKEY_B.slice(0, 16)) === PUBKEY_B);

  expect('refresh: unknown peer returns undefined',
    reg._resolveRoutingId('00'.repeat(32)) === undefined);
}

// ─── Test 2: real AXL routing-id resolves to full pubkey ────────────────

{
  const stub = new StubAxlClient({
    our_public_key: PUBKEY_A,
    peers: [{ public_key: PUBKEY_B }],
  });
  const reg = new PeerRegistry(stub);
  await reg.refresh();

  // The actual scenario: /recv returned X-From-Peer-Id = ROUTING_ID_B,
  // and we want to map that back to PUBKEY_B for outgoing /a2a.
  const resolved = reg._resolveRoutingId(ROUTING_ID_B);
  expect('routing-id resolves to full pubkey', resolved === PUBKEY_B,
    `got ${resolved}, expected ${PUBKEY_B}`);
}

// ─── Test 3: registerFromBid binds agent_id → pubkey ───────────────────

{
  const stub = new StubAxlClient({
    our_public_key: PUBKEY_A,
    peers: [{ public_key: PUBKEY_B }],
  });
  const reg = new PeerRegistry(stub);
  await reg.refresh();

  const bidEnvelope = {
    v: 1,
    method: 'defacts.bid',
    id: '0xtest',
    params: {
      agent_id: 'cache-001',
      query_id: '0xquery',
      receipt_cid: '0xab',
      price_wei: '500000000000000',
    },
    ts: 1234,
  };
  reg.registerFromBid(bidEnvelope, ROUTING_ID_B);

  expect('agent_id resolves to full pubkey',
    reg.resolveAgentId('cache-001') === PUBKEY_B);

  expect('knownAgents includes registered agent',
    reg.knownAgents().includes('cache-001'));
}

// ─── Test 4: registerFromBid without prior refresh falls back to routing-id ──

{
  const stub = new StubAxlClient({
    our_public_key: PUBKEY_A,
    peers: [],     // no topology yet (e.g., race at startup)
  });
  const reg = new PeerRegistry(stub);
  await reg.refresh();

  const bidEnvelope = {
    v: 1, method: 'defacts.bid', id: '0xt', ts: 1,
    params: { agent_id: 'mystery-agent' },
  };
  reg.registerFromBid(bidEnvelope, ROUTING_ID_B);

  // We don't know the full pubkey, so we record the routing id as the
  // best-effort address. Sending back to it via AXL still works because
  // AXL accepts routing prefixes.
  const resolved = reg.resolveAgentId('mystery-agent');
  expect('falls back to routing id when topology unknown',
    resolved === ROUTING_ID_B,
    `got ${resolved}`);
}

// ─── Test 5: input validation ───────────────────────────────────────────

{
  const reg = new PeerRegistry(new StubAxlClient({}));

  let threw = false;
  try { reg.registerFromBid({ v: 1, method: 'x', id: 'y', params: {} }, ROUTING_ID_B); }
  catch (e) { threw = true; }
  expect('rejects bid envelope with no agent_id', threw);

  threw = false;
  try { reg.registerFromBid({ v: 1, method: 'x', id: 'y', params: { agent_id: 'a' } }, ''); }
  catch (e) { threw = true; }
  expect('rejects empty fromPeerId', threw);

  threw = false;
  try { new PeerRegistry(null); } catch (e) { threw = true; }
  expect('constructor rejects null axlClient', threw);
}

// ─── Test 6: multiple agents on same AXL node ──────────────────────────

{
  const stub = new StubAxlClient({
    our_public_key: PUBKEY_A,
    peers: [{ public_key: PUBKEY_B }],
  });
  const reg = new PeerRegistry(stub);
  await reg.refresh();

  // Both cache-mode-agent and fresh-mode-agent live on node B
  reg.registerFromBid({
    v: 1, method: 'defacts.bid', id: '0x1', ts: 1,
    params: { agent_id: 'cache-001' },
  }, ROUTING_ID_B);
  reg.registerFromBid({
    v: 1, method: 'defacts.bid', id: '0x2', ts: 2,
    params: { agent_id: 'fresh-l4' },
  }, ROUTING_ID_B);

  expect('cache-001 → PUBKEY_B',  reg.resolveAgentId('cache-001') === PUBKEY_B);
  expect('fresh-l4   → PUBKEY_B', reg.resolveAgentId('fresh-l4')  === PUBKEY_B);
  expect('two agents share node', reg.knownAgents().length === 2);
}

// ─── Test 7: re-registration overwrites cleanly ────────────────────────

{
  const stub = new StubAxlClient({
    our_public_key: PUBKEY_A,
    peers: [{ public_key: PUBKEY_B }],
  });
  const reg = new PeerRegistry(stub);
  await reg.refresh();

  reg.registerFromBid({
    v: 1, method: 'defacts.bid', id: '0x1', ts: 1,
    params: { agent_id: 'rotating-agent' },
  }, ROUTING_ID_B);
  expect('first registration', reg.resolveAgentId('rotating-agent') === PUBKEY_B);

  // Same agent_id, different sender (e.g., agent rotated AXL nodes)
  reg.registerFromBid({
    v: 1, method: 'defacts.bid', id: '0x2', ts: 2,
    params: { agent_id: 'rotating-agent' },
  }, PUBKEY_A);  // pretend they're now on node A
  expect('re-registration overwrites', reg.resolveAgentId('rotating-agent') === PUBKEY_A);
}

// ─── Done ──────────────────────────────────────────────────────────────

console.log('');
console.log(`pass=${pass} fail=${fail}`);
process.exit(fail > 0 ? 1 : 0);
