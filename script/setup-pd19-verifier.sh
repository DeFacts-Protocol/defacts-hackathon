#!/bin/bash
# Block 6: Set up pd19-v1 verifier service.
#
# This is a one-time setup script. It:
#   1. Generates a fresh secp256k1 keypair for pd19.verifier.defacts.eth
#      (only if .env doesn't already have PD19_VERIFIER_PRIVKEY)
#   2. Boots a second prover-stub instance on :7011 with PROOF_FORMAT=pd19-v1
#   3. Boots a second verifier-stub instance on :7012 with PROOF_FORMAT=pd19-v1
#      using the new privkey
#   4. Registers the new verifier's address in VerifierRegistry on chain under
#      proof_format=pd19-v1
#
# After this, agents configured with PROOF_FORMAT=pd19-v1 will route their
# attestation requests to :7012, which signs under a different key, which
# resolves to a different on-chain verifier address — proving the registry
# works for multi-format routing.

set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$(pwd)"
echo "repo: $REPO"

if [ ! -f "$REPO/.env" ]; then echo "FAIL: $REPO/.env not found"; exit 1; fi
set -a; source "$REPO/.env"; set +a

for v in WALLET_PRIVKEY ZERO_G_RPC_URL VERIFIER_REGISTRY_ADDR ESCROW_ADDR; do
  if [ -z "${!v:-}" ]; then echo "FAIL: $v not set in .env"; exit 1; fi
done

# ─── Step 1: Generate or reuse pd19-v1 privkey ──────────────────────────

if [ -z "${PD19_VERIFIER_PRIVKEY:-}" ]; then
  echo "─── generating fresh PD19_VERIFIER_PRIVKEY ───"
  PD19_VERIFIER_PRIVKEY="0x$(openssl rand -hex 32)"
  echo "PD19_VERIFIER_PRIVKEY=$PD19_VERIFIER_PRIVKEY" >> "$REPO/.env"
  echo "  (written to .env)"
else
  echo "─── reusing existing PD19_VERIFIER_PRIVKEY from .env ───"
fi

# Derive the verifier address using cast
PD19_VERIFIER_ADDRESS=$(cast wallet address --private-key "$PD19_VERIFIER_PRIVKEY")
echo "  pd19 verifier address: $PD19_VERIFIER_ADDRESS"

# ─── Step 2: Boot pd19 prover-stub on :7011 ─────────────────────────────

# Kill any existing pd19 instances first (idempotent re-runs)
pkill -f "PROOF_FORMAT=pd19-v1" 2>/dev/null || true
sleep 1

LOGS=$(mktemp -d)
echo "logs: $LOGS"

echo "─── starting pd19 prover-stub on :7011 ───"
cd "$REPO/services/prover-stub"
PORT=7011 PROOF_FORMAT=pd19-v1 \
  node server.mjs > "$LOGS/pd19-prover.log" 2>&1 &
PD19_PROVER_PID=$!
cd "$REPO"

# Wait for ready
for i in $(seq 1 10); do
  if curl -sf http://localhost:7011/health >/dev/null 2>&1; then break; fi
  sleep 0.5
done
if ! curl -sf http://localhost:7011/health >/dev/null 2>&1; then
  echo "FAIL: pd19 prover-stub did not start"
  cat "$LOGS/pd19-prover.log"
  kill $PD19_PROVER_PID 2>/dev/null || true
  exit 1
fi
PROOF_FORMAT_REPORTED=$(curl -s http://localhost:7011/health | python3 -c "import sys,json; print(json.load(sys.stdin).get('proof_format'))")
if [ "$PROOF_FORMAT_REPORTED" != "pd19-v1" ]; then
  echo "FAIL: pd19 prover reports wrong proof_format: $PROOF_FORMAT_REPORTED"
  exit 1
fi
echo "  pd19 prover ready (pid $PD19_PROVER_PID, format $PROOF_FORMAT_REPORTED)"

# ─── Step 3: Boot pd19 verifier-stub on :7012 ───────────────────────────

echo "─── starting pd19 verifier-stub on :7012 ───"
cd "$REPO/services/verifier-stub"
PORT=7012 \
PROOF_FORMAT=pd19-v1 \
PROVER_ENDPOINT=http://localhost:7011 \
VERIFIER_PRIVKEY="$PD19_VERIFIER_PRIVKEY" \
ESCROW_ADDR="$ESCROW_ADDR" \
CHAIN_ID="${CHAIN_ID:-16602}" \
  node server.mjs > "$LOGS/pd19-verifier.log" 2>&1 &
PD19_VERIFIER_PID=$!
cd "$REPO"

for i in $(seq 1 10); do
  if curl -sf http://localhost:7012/health >/dev/null 2>&1; then break; fi
  sleep 0.5
done
if ! curl -sf http://localhost:7012/health >/dev/null 2>&1; then
  echo "FAIL: pd19 verifier-stub did not start"
  cat "$LOGS/pd19-verifier.log"
  kill $PD19_PROVER_PID $PD19_VERIFIER_PID 2>/dev/null || true
  exit 1
fi

# Cross-verify the address from the running service matches what we computed
RUNNING_ADDR=$(curl -s http://localhost:7012/address | python3 -c "import sys,json; print(json.load(sys.stdin)['verifier_address'])")
if [ "${RUNNING_ADDR,,}" != "${PD19_VERIFIER_ADDRESS,,}" ]; then
  echo "FAIL: pd19 verifier address mismatch (running=$RUNNING_ADDR, expected=$PD19_VERIFIER_ADDRESS)"
  exit 1
fi
echo "  pd19 verifier ready (pid $PD19_VERIFIER_PID, address $RUNNING_ADDR)"

# ─── Step 4: Register on chain in VerifierRegistry ──────────────────────

echo "─── checking on-chain VerifierRegistry ───"

# What does the registry currently say for pd19-v1?
EXISTING=$(cast call "$VERIFIER_REGISTRY_ADDR" \
  "getVerifier(string)(address)" "pd19-v1" \
  --rpc-url "$ZERO_G_RPC_URL" 2>/dev/null || echo "0x0000000000000000000000000000000000000000")

if [ "${EXISTING,,}" = "${PD19_VERIFIER_ADDRESS,,}" ]; then
  echo "  pd19-v1 already registered to $PD19_VERIFIER_ADDRESS — skipping"
elif [ "$EXISTING" != "0x0000000000000000000000000000000000000000" ]; then
  echo "  pd19-v1 currently registered to $EXISTING (different from our $PD19_VERIFIER_ADDRESS)"
  echo "  Registry expects updates via the deployer wallet. Re-registering..."
  cast send "$VERIFIER_REGISTRY_ADDR" \
    "register(string,address)" "pd19-v1" "$PD19_VERIFIER_ADDRESS" \
    --rpc-url "$ZERO_G_RPC_URL" \
    --private-key "$WALLET_PRIVKEY" \
    --legacy \
    --json | python3 -c "import sys,json; r=json.load(sys.stdin); print('  registered, tx:', r.get('transactionHash'))"
else
  echo "  pd19-v1 not registered — registering $PD19_VERIFIER_ADDRESS now"
  cast send "$VERIFIER_REGISTRY_ADDR" \
    "register(string,address)" "pd19-v1" "$PD19_VERIFIER_ADDRESS" \
    --rpc-url "$ZERO_G_RPC_URL" \
    --private-key "$WALLET_PRIVKEY" \
    --legacy \
    --json | python3 -c "import sys,json; r=json.load(sys.stdin); print('  registered, tx:', r.get('transactionHash'))"
fi

# Verify
FINAL=$(cast call "$VERIFIER_REGISTRY_ADDR" \
  "getVerifier(string)(address)" "pd19-v1" \
  --rpc-url "$ZERO_G_RPC_URL")
echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ✓ Block 6 setup complete"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  pd19 prover    :  http://localhost:7011  (pid $PD19_PROVER_PID)"
echo "  pd19 verifier  :  http://localhost:7012  (pid $PD19_VERIFIER_PID)"
echo "  pd19 address   :  $PD19_VERIFIER_ADDRESS"
echo "  registry says  :  $FINAL"
echo ""
echo "  stub-v1  (existing) → http://localhost:7002"
echo "  pd19-v1  (new)      → http://localhost:7012"
echo ""
echo "  Both registered on chain in VerifierRegistry at"
echo "    $VERIFIER_REGISTRY_ADDR"
echo ""
echo "  To stop pd19 services later:"
echo "    pkill -f 'PROOF_FORMAT=pd19-v1'"
echo ""

# Don't exit cleanup - keep the services running so subsequent acceptance
# tests can find them. Print PIDs so user can manually kill if needed.
echo "  pd19 services left running; PIDs $PD19_PROVER_PID and $PD19_VERIFIER_PID"
