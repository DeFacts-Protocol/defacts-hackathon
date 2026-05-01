#!/bin/bash
# End-of-Day-3 acceptance.
#
# Topology (one agent runtime per AXL node — clean separation):
#   Node A (api 9201): user-runtime    (the buyer)
#   Node B (api 9202): cache-mode-agent (cache-001)
#   Node C (api 9203): fresh-mode-agent (fresh-001)
#
# Why three nodes: AXL's /recv is destructive — first poller dequeues the
# message. Multiple agents on one node will fight over the queue. Each
# agent gets its own AXL node, peered through node-a as the hub.
#
# Flow:
#   1. user-runtime broadcasts defacts.query to its peers (node-b and node-c)
#   2. cache-001 on node-b: cache hit → bids 0.00005 ETH (instant)
#      fresh-001 on node-c: calls prover-stub → bids 0.0002 ETH
#   3. user-runtime sees both bids during the 4s window
#   4. user-runtime picks lowest (cache-001), sends defacts.accept to node-b
#   5. cache-001 returns deliver with receipt + Tier 1 attestation
#   6. user-runtime calls openTrade + settleTier1 on Galileo
#   7. on-chain Tier1Settled event confirmed

set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$(pwd)"
echo "repo: $REPO"

NODE_BIN="${NODE_BIN:-$HOME/defacts-hackathon/gate4-axl/axl/node}"
NODE_A_DIR="${NODE_A_DIR:-$HOME/axl-run/node-a}"
NODE_B_DIR="${NODE_B_DIR:-$HOME/axl-run/node-b}"
NODE_C_DIR="${NODE_C_DIR:-$HOME/axl-run/node-c}"
NODE_A_API="${NODE_A_API:-http://localhost:9201}"
NODE_B_API="${NODE_B_API:-http://localhost:9202}"
NODE_C_API="${NODE_C_API:-http://localhost:9203}"

if [ ! -f "$REPO/.env" ]; then echo "FAIL: $REPO/.env not found"; exit 1; fi
set -a; source "$REPO/.env"; set +a

for v in WALLET_PRIVKEY ZERO_G_RPC_URL ESCROW_ADDR VERIFIER_REGISTRY_ADDR; do
  if [ -z "${!v:-}" ]; then echo "FAIL: $v not set in .env"; exit 1; fi
done

# Sanity: all three node configs exist
for dir in "$NODE_A_DIR" "$NODE_B_DIR" "$NODE_C_DIR"; do
  if [ ! -f "$dir/node-config.json" ]; then echo "FAIL: missing $dir/node-config.json"; exit 1; fi
  if [ ! -f "$dir/private.pem" ];     then echo "FAIL: missing $dir/private.pem";    exit 1; fi
done

# ─── Sanity: stubs ──────────────────────────────────────────────────────

echo "─── checking stubs ───"
if ! curl -sf http://localhost:7001/health >/dev/null; then
  echo "FAIL: prover-stub :7001 not running"; exit 1
fi
if ! curl -sf http://localhost:7002/health >/dev/null; then
  echo "FAIL: verifier-stub :7002 not running"; exit 1
fi
VERIFIER_ESCROW=$(curl -s http://localhost:7002/health | python3 -c "import sys,json; print(json.load(sys.stdin)['escrow_addr'])")
if [ "${VERIFIER_ESCROW,,}" != "${ESCROW_ADDR,,}" ]; then
  echo "FAIL: verifier-stub escrow_addr mismatch"; exit 1
fi
echo "stubs healthy"

pkill -f "$NODE_BIN" 2>/dev/null || true
sleep 1

LOGS=$(mktemp -d)
echo "logs in: $LOGS"

# ─── Start three AXL nodes ──────────────────────────────────────────────

start_node() {
  local name="$1" dir="$2" api="$3"
  echo "─── starting node $name ───"
  cd "$dir"
  "$NODE_BIN" -config node-config.json > "$LOGS/node-$name.log" 2>&1 &
  local pid=$!
  cd "$REPO"
  for i in $(seq 1 10); do
    if curl -sf $api/topology >/dev/null 2>&1; then break; fi
    sleep 0.5
  done
  if ! curl -sf $api/topology >/dev/null 2>&1; then
    echo "FAIL: node $name did not come up"; cat "$LOGS/node-$name.log"; exit 1
  fi
  echo "node $name up (pid $pid)"
  echo "$pid"
}

# Capture pids — note the function echoes the PID as last line, plus other
# echoes go to stderr if we're careful. Simpler: capture output and grep.
# Actually start_node prints status AND echoes pid. To capture cleanly:
# we'll just track them ourselves.

echo "─── starting node a ───"
cd "$NODE_A_DIR"
"$NODE_BIN" -config node-config.json > "$LOGS/node-a.log" 2>&1 &
NODE_A_PID=$!
cd "$REPO"
for i in $(seq 1 10); do
  if curl -sf $NODE_A_API/topology >/dev/null 2>&1; then break; fi
  sleep 0.5
done
if ! curl -sf $NODE_A_API/topology >/dev/null 2>&1; then
  echo "FAIL: node a did not come up"; cat "$LOGS/node-a.log"
  kill $NODE_A_PID 2>/dev/null || true; exit 1
fi
echo "node a up (pid $NODE_A_PID)"

echo "─── starting node b ───"
cd "$NODE_B_DIR"
"$NODE_BIN" -config node-config.json > "$LOGS/node-b.log" 2>&1 &
NODE_B_PID=$!
cd "$REPO"
for i in $(seq 1 10); do
  if curl -sf $NODE_B_API/topology >/dev/null 2>&1; then break; fi
  sleep 0.5
done
if ! curl -sf $NODE_B_API/topology >/dev/null 2>&1; then
  echo "FAIL: node b did not come up"; cat "$LOGS/node-b.log"
  kill $NODE_A_PID $NODE_B_PID 2>/dev/null || true; exit 1
fi
echo "node b up (pid $NODE_B_PID)"

echo "─── starting node c ───"
cd "$NODE_C_DIR"
"$NODE_BIN" -config node-config.json > "$LOGS/node-c.log" 2>&1 &
NODE_C_PID=$!
cd "$REPO"
for i in $(seq 1 10); do
  if curl -sf $NODE_C_API/topology >/dev/null 2>&1; then break; fi
  sleep 0.5
done
if ! curl -sf $NODE_C_API/topology >/dev/null 2>&1; then
  echo "FAIL: node c did not come up"; cat "$LOGS/node-c.log"
  kill $NODE_A_PID $NODE_B_PID $NODE_C_PID 2>/dev/null || true; exit 1
fi
echo "node c up (pid $NODE_C_PID)"

cleanup() {
  echo ""; echo "─── cleanup ───"
  kill ${CACHE_PID:-} ${FRESH_PID:-} $NODE_A_PID $NODE_B_PID $NODE_C_PID 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

# ─── Wait for full topology to mesh ─────────────────────────────────────

echo "─── waiting for topology mesh (node-a needs 2 peers) ───"
for i in $(seq 1 30); do
  PEERS_A=$(curl -s $NODE_A_API/topology | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('peers') or []))" 2>/dev/null || echo 0)
  if [ "$PEERS_A" -ge 2 ]; then break; fi
  sleep 0.5
done
if [ "$PEERS_A" -lt 2 ]; then
  echo "FAIL: node-a only sees $PEERS_A peer(s), expected 2"
  cat "$LOGS/node-a.log" | tail -10
  cat "$LOGS/node-b.log" | tail -10
  cat "$LOGS/node-c.log" | tail -10
  exit 1
fi
echo "node-a sees $PEERS_A peers"

PUBKEY_A=$(curl -s $NODE_A_API/topology | python3 -c "import sys,json; print(json.load(sys.stdin)['our_public_key'])")
PUBKEY_B=$(curl -s $NODE_B_API/topology | python3 -c "import sys,json; print(json.load(sys.stdin)['our_public_key'])")
PUBKEY_C=$(curl -s $NODE_C_API/topology | python3 -c "import sys,json; print(json.load(sys.stdin)['our_public_key'])")
echo "node-a pubkey: ${PUBKEY_A:0:16}..."
echo "node-b pubkey: ${PUBKEY_B:0:16}..."
echo "node-c pubkey: ${PUBKEY_C:0:16}..."

# ─── Start cache-mode-agent on node-b ───────────────────────────────────

echo "─── starting cache-mode-agent on node-b ───"
cd "$REPO/agents/cache"
AXL_API_BASE="$NODE_B_API" \
VERIFIER_URL="${CACHE_VERIFIER_URL:-http://localhost:7002}" \
AGENT_ID="cache-001" \
PRICE_WEI="50000000000000" \
FIXTURES_DIR="$REPO/agents/cache/fixtures" \
node src/main.mjs > "$LOGS/cache-agent.log" 2>&1 &
CACHE_PID=$!
cd "$REPO"

for i in $(seq 1 20); do
  if grep -q "CACHE_AGENT_READY" "$LOGS/cache-agent.log" 2>/dev/null; then break; fi
  sleep 0.25
done
if ! grep -q "CACHE_AGENT_READY" "$LOGS/cache-agent.log" 2>/dev/null; then
  echo "FAIL: cache-agent did not signal ready"
  cat "$LOGS/cache-agent.log"; exit 1
fi
echo "cache-agent ready on node-b (pid $CACHE_PID)"

# ─── Start fresh-mode-agent on node-c ───────────────────────────────────

echo "─── starting fresh-mode-agent on node-c ───"
cd "$REPO/agents/fresh"
AXL_API_BASE="$NODE_C_API" \
PROVER_ENDPOINT="${PROVER_ENDPOINT:-http://localhost:7001}" \
VERIFIER_URL="${FRESH_VERIFIER_URL:-http://localhost:7002}" \
AGENT_ID="fresh-001" \
PRICE_WEI="200000000000000" \
node src/main.mjs > "$LOGS/fresh-agent.log" 2>&1 &
FRESH_PID=$!
cd "$REPO"

for i in $(seq 1 20); do
  if grep -q "FRESH_AGENT_READY" "$LOGS/fresh-agent.log" 2>/dev/null; then break; fi
  sleep 0.25
done
if ! grep -q "FRESH_AGENT_READY" "$LOGS/fresh-agent.log" 2>/dev/null; then
  echo "FAIL: fresh-agent did not signal ready"
  cat "$LOGS/fresh-agent.log"; exit 1
fi
echo "fresh-agent ready on node-c (pid $FRESH_PID)"
echo ""

# ─── Run JS driver ──────────────────────────────────────────────────────

echo "═══════════════════════════════════════════════════════════"
echo "  END-OF-DAY-3 ACCEPTANCE — competitive marketplace"
echo "═══════════════════════════════════════════════════════════"
echo "  Buyer:    user-runtime on node-a (api $NODE_A_API)"
echo "  Supplier: cache-001    on node-b (price 0.00005 ETH, cache hit)"
echo "  Supplier: fresh-001    on node-c (price 0.00020 ETH, fresh prover)"
echo ""
NODE_A_API="$NODE_A_API" \
ESCROW_ADDR="$ESCROW_ADDR" \
ZERO_G_RPC_URL="$ZERO_G_RPC_URL" \
WALLET_PRIVKEY="$WALLET_PRIVKEY" \
ENABLE_ENS="${ENABLE_ENS:-}" \
ENS_OWNER_PRIVKEY="${ENS_OWNER_PRIVKEY:-}" \
SEPOLIA_RPC_URL="${SEPOLIA_RPC_URL:-}" \
node "$REPO/script/end-of-day-3-driver.mjs"

echo ""
echo "─── cache-agent log ───"
tail -10 "$LOGS/cache-agent.log"
echo ""
echo "─── fresh-agent log ───"
tail -10 "$LOGS/fresh-agent.log"

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ✓ END-OF-DAY-3 ACCEPTANCE PASSED"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  Three AXL nodes coordinated a real marketplace round-trip."
echo "  user posts query → both suppliers bid → cheapest wins → on-chain settle."
echo ""
echo "  Day 3 closed. Tomorrow: Day 4 (Tier 2 + non-resale + pd19-v1 verifier)."
