/**
 * AXL transport acceptance driver.
 *
 * Run by acceptance.sh after both AXL nodes are up and peered. Exercises
 * the AxlClient end-to-end against the real AXL HTTP API.
 */

import { AxlClient } from '../src/client.mjs';
import { gossipBuild, gossipParse } from '../src/envelope.mjs';
import { METHODS } from '../src/methods.mjs';
import { peerIdMatches } from '../src/peerid.mjs';

const NODE_A_API = process.env.NODE_A_API;
const NODE_B_API = process.env.NODE_B_API;
const PUBKEY_A   = process.env.PUBKEY_A;
const PUBKEY_B   = process.env.PUBKEY_B;

if (!NODE_A_API || !NODE_B_API || !PUBKEY_A || !PUBKEY_B) {
  console.error('FAIL: required env vars missing');
  process.exit(1);
}

const a = new AxlClient({ apiBase: NODE_A_API });
const b = new AxlClient({ apiBase: NODE_B_API });

// Helper: poll recv until we get a message or timeout
async function waitForMessage(client, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = await client.recvGossip();
    if (msg) return msg;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

let testNum = 0;
function pass(label) { console.log(`✓ Test ${++testNum}: ${label}`); }
function fail(label, detail) { console.error(`✗ Test ${++testNum}: ${label}`); if (detail) console.error('  ', detail); process.exit(1); }

// ─── Test 1: /topology returns expected shape ───────────────────────────

const topoA = await a.getTopology();
const topoB = await b.getTopology();
if (topoA.our_public_key === PUBKEY_A) pass('node A /topology returns its pubkey');
else fail('node A pubkey mismatch', `${topoA.our_public_key} !== ${PUBKEY_A}`);

if (topoB.our_public_key === PUBKEY_B) pass('node B /topology returns its pubkey');
else fail('node B pubkey mismatch');

// Both should see each other in the peers list.
// peers[] is array of objects with .public_key (per AXL source); accept any field name carrying the key.
const peersAHas = JSON.stringify(topoA.peers || []).includes(PUBKEY_B);
const peersBHas = JSON.stringify(topoB.peers || []).includes(PUBKEY_A);
if (peersAHas) pass('node A topology includes node B as peer');
else fail('node A does not see node B', JSON.stringify(topoA.peers));
if (peersBHas) pass('node B topology includes node A as peer');
else fail('node B does not see node A', JSON.stringify(topoB.peers));

// ─── Test 2: client.ourPublicKey() caches ───────────────────────────────

const cached1 = await a.ourPublicKey();
const cached2 = await a.ourPublicKey();
if (cached1 === PUBKEY_A && cached1 === cached2) pass('ourPublicKey() returns and caches');
else fail('ourPublicKey caching broken');

// ─── Drain any residual messages from previous runs ─────────────────────

let drained = 0;
while (await a.recv()) { drained++; if (drained > 10) break; }
while (await b.recv()) { drained++; if (drained > 20) break; }
if (drained > 0) console.log(`  (drained ${drained} stale messages)`);

// ─── Test 3: B sends defacts.query gossip to A ──────────────────────────

const queryParams = {
  prompt_label: 'The capital of France is',
  input_token_ids: [785, 6722, 315, 9625, 374],
  max_output_tokens: 20,
  decoding: 'greedy',
  budget_wei: '1000000000000000',
  proof_format: 'stub-v1',
};

const sendResult = await b.sendGossip(PUBKEY_A, METHODS.QUERY, queryParams);
if (sendResult.sentBytes > 0) pass('B sent /send to A');
else fail('B /send returned 0 bytes sent');

const incoming = await waitForMessage(a, 5000);
if (!incoming) fail('A did not receive the message within 5s');
if (incoming.envelope?.method === METHODS.QUERY) pass('A received and parsed defacts.query envelope');
else fail('A received wrong method', JSON.stringify(incoming));

if (peerIdMatches(incoming.fromPeerId, PUBKEY_B)) pass('A sees fromPeerId matches node B (routing prefix)');
else fail('fromPeerId does not match node B', `${incoming.fromPeerId} vs ${PUBKEY_B}`);

if (incoming.envelope.params.input_token_ids?.[0] === 785) pass('params survived round-trip');
else fail('params corruption', JSON.stringify(incoming.envelope.params));

// ─── Test 4: A replies with defacts.bid back to B ───────────────────────

const bidParams = {
  query_id: incoming.envelope.id,
  receipt_cid: '0x' + 'ab'.repeat(32),
  price_wei: '500000000000000',
  proof_format: 'stub-v1',
  ttl_seconds: 60,
};

await a.sendGossip(PUBKEY_B, METHODS.BID, bidParams, incoming.envelope.id);
pass('A sent defacts.bid to B');

const bidIncoming = await waitForMessage(b, 5000);
if (!bidIncoming) fail('B did not receive the bid within 5s');
if (bidIncoming.envelope?.method === METHODS.BID) pass('B received and parsed defacts.bid envelope');
else fail('B received wrong method on bid', JSON.stringify(bidIncoming));

if (bidIncoming.envelope.id === incoming.envelope.id) pass('bid id correlates to query id');
else fail('bid id correlation broken');

if (bidIncoming.envelope.params.price_wei === '500000000000000') pass('bid params survived round-trip');
else fail('bid params corruption');

// ─── Test 5: malformed (non-envelope) bytes parse-fail gracefully ──────

await b.send(PUBKEY_A, Buffer.from('this is not json at all'));
const garbage = await waitForMessage(a, 3000);
if (!garbage) fail('A did not receive the garbage message');
if (garbage.parseError && garbage.bytes) pass('non-envelope bytes returned with parseError');
else fail('garbage handling broken', JSON.stringify(garbage).slice(0, 200));

// ─── Test 6: envelope round-trip is byte-stable for our build/parse ─────

const original = { method: METHODS.QUERY, params: { x: 1, y: 'hello' } };
const env = gossipBuild(original.method, original.params, '0xabc123');
const parsed = gossipParse(env);
if (parsed.method === original.method && parsed.params.x === 1 && parsed.params.y === 'hello' && parsed.id === '0xabc123') {
  pass('envelope build/parse round-trip is lossless');
} else {
  fail('envelope round-trip broken', JSON.stringify(parsed));
}

// ─── Test 7: gossipParse rejects malformed envelopes ──────────────────

const cases = [
  ['not json at all', 'invalid JSON'],
  ['{}', 'missing method'],
  ['{"v": 99, "method": "x", "id": "y"}', 'unsupported version'],
  ['{"v": 1, "id": "y"}', 'missing method'],
  ['{"v": 1, "method": "x"}', 'missing id'],
];

let parseFails = 0;
for (const [input, expectedSubstring] of cases) {
  try {
    gossipParse(input);
    fail(`gossipParse should have rejected: ${input.slice(0, 30)}`);
  } catch (e) {
    if (e.message.includes(expectedSubstring)) parseFails++;
    else fail(`gossipParse error wrong message`, `${e.message} did not contain ${expectedSubstring}`);
  }
}
if (parseFails === cases.length) pass(`gossipParse rejects all ${cases.length} malformed inputs`);

// ─── Test 8: recvLoop drains messages asynchronously ──────────────────

let received = 0;
const stop = a.recvLoop((msg) => {
  if (msg.envelope?.method === METHODS.QUERY) received++;
});

await b.sendGossip(PUBKEY_A, METHODS.QUERY, { batch: 1 });
await b.sendGossip(PUBKEY_A, METHODS.QUERY, { batch: 2 });
await b.sendGossip(PUBKEY_A, METHODS.QUERY, { batch: 3 });

// Wait up to 5s for all 3 to arrive
const dl = Date.now() + 5000;
while (Date.now() < dl && received < 3) {
  await new Promise((r) => setTimeout(r, 100));
}
stop();

if (received >= 3) pass(`recvLoop drained 3 queries asynchronously (got ${received})`);
else fail(`recvLoop incomplete (got ${received}/3)`);

// ─── Done ────────────────────────────────────────────────────────────

console.log('');
console.log(`All ${testNum} tests passed.`);
