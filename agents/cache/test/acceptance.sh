#!/bin/bash
# cache-mode-agent acceptance test.
#
# Validates the cache-mode-agent integrates with the rest of the stack:
#   1. Two AXL nodes peered
#   2. prover-stub (only consulted by user driver setup, not by cache-agent)
#   3. verifier-stub :7002 with deployed Escrow address
#   4. cache-mode-agent on node B with france.json loaded
#   5. user-runtime on node A queries for "The capital of France is"
#   6. cache-agent bids, user accepts, cache-agent delivers
#   7. user-runtime calls openTrade + settleTier1 on Galileo
#   8. on-chain Tier1Settled event confirmed

set -euo pipefail

cd "$(dirname "$0")/.."
TEST_DIR="$(pwd)"
REPO="$(cd ../.. && pwd)"
echo "test dir: $TEST_DIR"
echo "repo:     $REPO"

NODE_BIN="${NODE_BIN:-$HOME/defacts-hackathon/gate4-axl/axl/node}"
NODE_A_DIR="${NODE_A_DIR:-$HOME/axl-run/node-a}"
NODE_B_DIR="${NODE_B_DIR:-$HOME/axl-run/node-b}"
NODE_A_API="${NODE_A_API:-http://localhost:9201}"
NODE_B_API="${NODE_B_API:-http://localhost:9202}"

# Load .env
if [ ! -f "$REPO/.env" ]; then echo "FAIL: $REPO/.env not found"; exit 1; fi
set -a; source "$REPO/.env"; set +a

for v in WALLET_PRIVKEY ZERO_G_RPC_URL ESCROW_ADDR VERIFIER_REGISTRY_ADDR; do
  if [ -z "${!v:-}" ]; then echo "FAIL: $v not set in .env"; exit 1; fi
done

# ─── Sanity: stubs ──────────────────────────────────────────────────────

echo "─── checking stubs ───"
if ! curl -sf http://localhost:7002/health >/dev/null; then
  echo "FAIL: verifier-stub :7002 not running"
  exit 1
fi
VERIFIER_ESCROW=$(curl -s http://localhost:7002/health | python3 -c "import sys,json; print(json.load(sys.stdin)['escrow_addr'])")
if [ "${VERIFIER_ESCROW,,}" != "${ESCROW_ADDR,,}" ]; then
  echo "FAIL: verifier-stub configured with wrong ESCROW_ADDR"
  echo "  verifier: $VERIFIER_ESCROW"
  echo "  .env:     $ESCROW_ADDR"
  exit 1
fi
echo "verifier-stub healthy, escrow_addr matches .env"

# ─── Kill any pre-existing AXL processes ────────────────────────────────

pkill -f "$NODE_BIN" 2>/dev/null || true
sleep 1

LOGS=$(mktemp -d)
echo "logs in: $LOGS"

# ─── Start AXL node A ───────────────────────────────────────────────────

echo "─── starting node A ───"
cd "$NODE_A_DIR"
"$NODE_BIN" -config node-config.json > "$LOGS/node-a.log" 2>&1 &
NODE_A_PID=$!
cd "$TEST_DIR"
for i in $(seq 1 10); do
  if curl -sf $NODE_A_API/topology >/dev/null 2>&1; then break; fi
  sleep 0.5
done
if ! curl -sf $NODE_A_API/topology >/dev/null 2>&1; then
  echo "FAIL: node A did not come up"; cat "$LOGS/node-a.log"
  kill $NODE_A_PID 2>/dev/null || true; exit 1
fi
echo "node A up (pid $NODE_A_PID)"

# ─── Start AXL node B ───────────────────────────────────────────────────

echo "─── starting node B ───"
cd "$NODE_B_DIR"
"$NODE_BIN" -config node-config.json > "$LOGS/node-b.log" 2>&1 &
NODE_B_PID=$!
cd "$TEST_DIR"

cleanup() {
  echo ""; echo "─── cleanup ───"
  kill ${CACHE_PID:-} $NODE_A_PID $NODE_B_PID 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

for i in $(seq 1 10); do
  if curl -sf $NODE_B_API/topology >/dev/null 2>&1; then break; fi
  sleep 0.5
done
if ! curl -sf $NODE_B_API/topology >/dev/null 2>&1; then
  echo "FAIL: node B did not come up"; cat "$LOGS/node-b.log"; exit 1
fi
echo "node B up (pid $NODE_B_PID)"

# ─── Wait for peering ───────────────────────────────────────────────────

echo "─── waiting for peering ───"
for i in $(seq 1 30); do
  PEERS_A=$(curl -s $NODE_A_API/topology | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('peers') or []))" 2>/dev/null || echo 0)
  if [ "$PEERS_A" -gt 0 ]; then break; fi
  sleep 0.5
done
if [ "$PEERS_A" -eq 0 ]; then
  echo "FAIL: nodes did not peer"
  cat "$LOGS/node-a.log" | tail -10; cat "$LOGS/node-b.log" | tail -10; exit 1
fi
echo "peered"

# ─── Start cache-mode-agent on node B ───────────────────────────────────

echo "─── starting cache-mode-agent ───"
cd "$TEST_DIR"
AXL_API_BASE="$NODE_B_API" \
VERIFIER_URL="http://localhost:7002" \
AGENT_ID="cache-001" \
PRICE_WEI="50000000000000" \
FIXTURES_DIR="$TEST_DIR/fixtures" \
node src/main.mjs > "$LOGS/cache-agent.log" 2>&1 &
CACHE_PID=$!

for i in $(seq 1 20); do
  if grep -q "CACHE_AGENT_READY" "$LOGS/cache-agent.log" 2>/dev/null; then break; fi
  sleep 0.25
done
if ! grep -q "CACHE_AGENT_READY" "$LOGS/cache-agent.log" 2>/dev/null; then
  echo "FAIL: cache-agent did not signal ready"
  cat "$LOGS/cache-agent.log"; exit 1
fi
echo "cache-agent ready (pid $CACHE_PID)"
echo ""

# ─── Run JS driver: spin up user-runtime, run query→settle ──────────────

echo "─── running cache-mode acceptance ───"
cd "$TEST_DIR"
NODE_A_API="$NODE_A_API" \
ESCROW_ADDR="$ESCROW_ADDR" \
ZERO_G_RPC_URL="$ZERO_G_RPC_URL" \
WALLET_PRIVKEY="$WALLET_PRIVKEY" \
node test/driver.mjs

echo ""
echo "─── cache-agent log ───"
tail -25 "$LOGS/cache-agent.log"

echo ""
echo "================================="
echo "CACHE-MODE-AGENT ACCEPTANCE PASSED"
echo "================================="
