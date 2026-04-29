#!/bin/bash
# AXL transport acceptance test.
#
# Validates the AxlClient can:
#   1. Discover each node's public key via /topology
#   2. Wait for the two nodes to peer
#   3. Send a defacts.query gossip envelope from node B to node A via /send
#   4. Receive and parse it on node A via /recv
#   5. Send a defacts.bid reply from A to B
#   6. Receive and parse it on B
#   7. Reject malformed (non-envelope) bytes gracefully
#
# Prerequisites:
#   - axl node binary at ~/defacts-hackathon/gate4-axl/axl/node
#   - node-a and node-b configs at ~/axl-run/{node-a,node-b}/node-config.json
#   - Both configs have already been generated with private.pem keys
#
# This script starts both AXL nodes in the background, runs the test,
# and tears them down.

set -euo pipefail

cd "$(dirname "$0")/.."
TEST_DIR="$(pwd)"
echo "test dir: $TEST_DIR"

NODE_BIN="${NODE_BIN:-$HOME/defacts-hackathon/gate4-axl/axl/node}"
NODE_A_DIR="${NODE_A_DIR:-$HOME/axl-run/node-a}"
NODE_B_DIR="${NODE_B_DIR:-$HOME/axl-run/node-b}"
NODE_A_API="${NODE_A_API:-http://localhost:9201}"
NODE_B_API="${NODE_B_API:-http://localhost:9202}"

# Sanity checks
if [ ! -x "$NODE_BIN" ];                          then echo "FAIL: AXL node binary not found at $NODE_BIN"; exit 1; fi
if [ ! -f "$NODE_A_DIR/node-config.json" ];       then echo "FAIL: $NODE_A_DIR/node-config.json missing";    exit 1; fi
if [ ! -f "$NODE_B_DIR/node-config.json" ];       then echo "FAIL: $NODE_B_DIR/node-config.json missing";    exit 1; fi

# Kill any pre-existing AXL processes (safety)
pkill -f "$NODE_BIN" 2>/dev/null || true
sleep 1

LOGS=$(mktemp -d)
echo "logs in: $LOGS"

# ─── Start node A (listener) ────────────────────────────────────────────
echo "─── starting node A ───"
cd "$NODE_A_DIR"
"$NODE_BIN" -config node-config.json > "$LOGS/node-a.log" 2>&1 &
NODE_A_PID=$!
cd "$TEST_DIR"
echo "node A pid: $NODE_A_PID"

# ─── Wait for node A api to come up ─────────────────────────────────────
for i in $(seq 1 10); do
  if curl -sf $NODE_A_API/topology >/dev/null 2>&1; then break; fi
  sleep 0.5
done
if ! curl -sf $NODE_A_API/topology >/dev/null 2>&1; then
  echo "FAIL: node A api did not come up. Log:"
  cat "$LOGS/node-a.log"
  kill $NODE_A_PID 2>/dev/null || true
  exit 1
fi
echo "node A api up"

# ─── Start node B (peers to node A) ─────────────────────────────────────
echo "─── starting node B ───"
cd "$NODE_B_DIR"
"$NODE_BIN" -config node-config.json > "$LOGS/node-b.log" 2>&1 &
NODE_B_PID=$!
cd "$TEST_DIR"
echo "node B pid: $NODE_B_PID"

cleanup() {
  echo ""
  echo "─── cleanup ───"
  kill $NODE_A_PID $NODE_B_PID 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT

for i in $(seq 1 10); do
  if curl -sf $NODE_B_API/topology >/dev/null 2>&1; then break; fi
  sleep 0.5
done
if ! curl -sf $NODE_B_API/topology >/dev/null 2>&1; then
  echo "FAIL: node B api did not come up. Log:"
  cat "$LOGS/node-b.log"
  exit 1
fi
echo "node B api up"

# ─── Wait for peering ───────────────────────────────────────────────────
echo "─── waiting for nodes to peer (up to 15s) ───"
for i in $(seq 1 30); do
  PEERS_A=$(curl -s $NODE_A_API/topology | python3 -c "import sys,json; t=json.load(sys.stdin); print(len(t.get('peers') or []))" 2>/dev/null || echo 0)
  PEERS_B=$(curl -s $NODE_B_API/topology | python3 -c "import sys,json; t=json.load(sys.stdin); print(len(t.get('peers') or []))" 2>/dev/null || echo 0)
  if [ "$PEERS_A" -gt 0 ] && [ "$PEERS_B" -gt 0 ]; then
    echo "peered: A has $PEERS_A peer(s), B has $PEERS_B peer(s)"
    break
  fi
  sleep 0.5
done
if [ "$PEERS_A" -eq 0 ] || [ "$PEERS_B" -eq 0 ]; then
  echo "FAIL: nodes did not peer. A peers=$PEERS_A B peers=$PEERS_B"
  echo "── node-a log ──"; cat "$LOGS/node-a.log" | tail -20
  echo "── node-b log ──"; cat "$LOGS/node-b.log" | tail -20
  exit 1
fi

# ─── Capture pubkeys ────────────────────────────────────────────────────
PUBKEY_A=$(curl -s $NODE_A_API/topology | python3 -c "import sys,json; print(json.load(sys.stdin)['our_public_key'])")
PUBKEY_B=$(curl -s $NODE_B_API/topology | python3 -c "import sys,json; print(json.load(sys.stdin)['our_public_key'])")
echo "node A pubkey: $PUBKEY_A"
echo "node B pubkey: $PUBKEY_B"
echo ""

# ─── Run the Node.js test driver ────────────────────────────────────────
echo "─── running JS acceptance ───"
NODE_A_API="$NODE_A_API" \
NODE_B_API="$NODE_B_API" \
PUBKEY_A="$PUBKEY_A" \
PUBKEY_B="$PUBKEY_B" \
node test/driver.mjs

echo ""
echo "================================="
echo "ALL ACCEPTANCE TESTS PASSED"
echo "================================="
