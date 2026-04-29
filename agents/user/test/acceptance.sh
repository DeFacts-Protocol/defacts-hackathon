#!/bin/bash
# user-runtime acceptance test.
#
# Single-command end-to-end:
#   1. Boots two AXL nodes
#   2. Verifies prover-stub :7001 and verifier-stub :7002 are running
#   3. Boots mock-supplier on node B (in background)
#   4. Runs UserRuntime on node A: query → bid → accept → on-chain settle
#   5. Verifies a SECOND on-chain Tier1Settled event on Galileo (different
#      from Day 2's manual settle — this one is driven by the runtime)
#   6. Tears down everything
#
# Prerequisites:
#   - prover-stub running on :7001
#   - verifier-stub running on :7002 with ESCROW_ADDR matching .env
#   - .env has WALLET_PRIVKEY, ZERO_G_RPC_URL, ESCROW_ADDR, VERIFIER_REGISTRY_ADDR

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

# Load .env from repo root
if [ ! -f "$REPO/.env" ]; then echo "FAIL: $REPO/.env not found"; exit 1; fi
set -a; source "$REPO/.env"; set +a

# Required env
for v in WALLET_PRIVKEY ZERO_G_RPC_URL ESCROW_ADDR VERIFIER_REGISTRY_ADDR; do
  if [ -z "${!v:-}" ]; then echo "FAIL: $v not set in .env"; exit 1; fi
done

# ─── Sanity: stubs ──────────────────────────────────────────────────────

echo "─── checking stubs ───"
if ! curl -sf http://localhost:7001/health >/dev/null; then
  echo "FAIL: prover-stub :7001 not running"
  echo "  start it: cd services/prover-stub && node server.mjs"
  exit 1
fi
if ! curl -sf http://localhost:7002/health >/dev/null; then
  echo "FAIL: verifier-stub :7002 not running"
  echo "  start it: cd services/verifier-stub && ESCROW_ADDR=$ESCROW_ADDR \\"
  echo "             VERIFIER_PRIVKEY=\$(grep ^VERIFIER_PRIVKEY= .env | cut -d= -f2) \\"
  echo "             node server.mjs"
  exit 1
fi
VERIFIER_ESCROW=$(curl -s http://localhost:7002/health | python3 -c "import sys,json; print(json.load(sys.stdin)['escrow_addr'])")
if [ "${VERIFIER_ESCROW,,}" != "${ESCROW_ADDR,,}" ]; then
  echo "FAIL: verifier-stub configured with ESCROW_ADDR=$VERIFIER_ESCROW"
  echo "      but .env has ESCROW_ADDR=$ESCROW_ADDR"
  exit 1
fi
echo "stubs healthy, verifier escrow_addr matches .env"

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
  echo "FAIL: node A api did not come up"
  cat "$LOGS/node-a.log"
  kill $NODE_A_PID 2>/dev/null || true
  exit 1
fi
echo "node A api up (pid $NODE_A_PID)"

# ─── Start AXL node B ───────────────────────────────────────────────────

echo "─── starting node B ───"
cd "$NODE_B_DIR"
"$NODE_BIN" -config node-config.json > "$LOGS/node-b.log" 2>&1 &
NODE_B_PID=$!
cd "$TEST_DIR"

cleanup() {
  echo ""
  echo "─── cleanup ───"
  kill $NODE_A_PID $NODE_B_PID ${MOCK_PID:-} 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

for i in $(seq 1 10); do
  if curl -sf $NODE_B_API/topology >/dev/null 2>&1; then break; fi
  sleep 0.5
done
if ! curl -sf $NODE_B_API/topology >/dev/null 2>&1; then
  echo "FAIL: node B api did not come up"
  cat "$LOGS/node-b.log"
  exit 1
fi
echo "node B api up (pid $NODE_B_PID)"

# ─── Wait for peering ───────────────────────────────────────────────────

echo "─── waiting for peering ───"
for i in $(seq 1 30); do
  PEERS_A=$(curl -s $NODE_A_API/topology | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('peers') or []))" 2>/dev/null || echo 0)
  if [ "$PEERS_A" -gt 0 ]; then break; fi
  sleep 0.5
done
if [ "$PEERS_A" -eq 0 ]; then
  echo "FAIL: nodes did not peer"
  cat "$LOGS/node-a.log" | tail -10
  cat "$LOGS/node-b.log" | tail -10
  exit 1
fi
echo "peered"

# ─── Start mock supplier on node B ──────────────────────────────────────

echo "─── starting mock supplier ───"
cd "$TEST_DIR"
NODE_B_API="$NODE_B_API" \
PROVER_URL="http://localhost:7001" \
VERIFIER_URL="http://localhost:7002" \
AGENT_ID="mock-supplier-1" \
PRICE_WEI="100000000000000" \
node test/mock-supplier.mjs > "$LOGS/mock-supplier.log" 2>&1 &
MOCK_PID=$!

# Wait for "MOCK_SUPPLIER_READY" sentinel in the log
for i in $(seq 1 20); do
  if grep -q "MOCK_SUPPLIER_READY" "$LOGS/mock-supplier.log" 2>/dev/null; then break; fi
  sleep 0.25
done
if ! grep -q "MOCK_SUPPLIER_READY" "$LOGS/mock-supplier.log" 2>/dev/null; then
  echo "FAIL: mock-supplier did not signal ready"
  cat "$LOGS/mock-supplier.log"
  exit 1
fi
echo "mock-supplier ready (pid $MOCK_PID)"
echo ""

# ─── Run JS driver against the live stack ──────────────────────────────

echo "─── running user-runtime acceptance ───"
cd "$TEST_DIR"
NODE_A_API="$NODE_A_API" \
NODE_B_API="$NODE_B_API" \
ESCROW_ADDR="$ESCROW_ADDR" \
ZERO_G_RPC_URL="$ZERO_G_RPC_URL" \
WALLET_PRIVKEY="$WALLET_PRIVKEY" \
node test/driver.mjs

echo ""
echo "─── mock-supplier log ───"
tail -20 "$LOGS/mock-supplier.log"

echo ""
echo "================================="
echo "USER-RUNTIME ACCEPTANCE PASSED"
echo "================================="
