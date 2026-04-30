#!/usr/bin/env bash
# PD19 adapter acceptance test
# Spins up the adapter, points it at a real PD19 endpoint (RunPod),
# verifies the marketplace /prove → real PD19 /infer round-trip works.
set -euo pipefail

cd "$(dirname "$0")/.."
ADAPTER_DIR="$(pwd)"

# ─── Required env ──────────────────────────────────────────────────────────

PD19_INFER_URL="${PD19_INFER_URL:-https://eyv0x8k3nbce9a-7860.proxy.runpod.net/infer}"
ADAPTER_PORT="${ADAPTER_PORT:-7011}"
PD19_BACKEND_LABEL="${PD19_BACKEND_LABEL:-l4}"

PASS=0
FAIL=0

pass() {
  PASS=$((PASS + 1))
  echo "✓ Test $((PASS + FAIL)): $1"
}

fail() {
  FAIL=$((FAIL + 1))
  echo "✗ Test $((PASS + FAIL)): $1"
  echo "    $2"
}

cleanup() {
  if [ -n "${ADAPTER_PID:-}" ]; then
    kill "$ADAPTER_PID" 2>/dev/null || true
    wait "$ADAPTER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ─── Pre-flight: confirm we can reach PD19 directly ────────────────────────

echo "─── pre-flight: confirming PD19 reachable at $PD19_INFER_URL ───"
PD19_DIRECT=$(curl -sS -X POST "$PD19_INFER_URL" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"The capital of France is","max_tokens":20}' \
  --max-time 30)

PD19_HASH=$(echo "$PD19_DIRECT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('hash', ''))")
PD19_DETERMINISTIC=$(echo "$PD19_DIRECT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('deterministic', False))")

if [ -z "$PD19_HASH" ]; then
  echo "FAIL: PD19 endpoint returned no hash. Response was:"
  echo "$PD19_DIRECT" | head -200
  exit 1
fi

echo "  PD19 reachable: hash=$PD19_HASH deterministic=$PD19_DETERMINISTIC"

# ─── Start the adapter ─────────────────────────────────────────────────────

echo ""
echo "─── starting adapter on :$ADAPTER_PORT (backend=$PD19_BACKEND_LABEL) ───"

PORT="$ADAPTER_PORT" \
PD19_INFER_URL="$PD19_INFER_URL" \
PD19_BACKEND_LABEL="$PD19_BACKEND_LABEL" \
node "$ADAPTER_DIR/src/server.mjs" &
ADAPTER_PID=$!

# Wait for adapter to come up
for i in $(seq 1 20); do
  if curl -s "http://localhost:$ADAPTER_PORT/health" > /dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

if ! curl -s "http://localhost:$ADAPTER_PORT/health" > /dev/null 2>&1; then
  echo "FAIL: adapter did not come up on :$ADAPTER_PORT"
  exit 1
fi

# ─── Tests ─────────────────────────────────────────────────────────────────

echo ""
echo "─── running adapter acceptance ───"

# Test 1: health endpoint
HEALTH=$(curl -sS "http://localhost:$ADAPTER_PORT/health")
HEALTH_OK=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null || echo "false")
if [ "$HEALTH_OK" = "True" ]; then
  pass "health endpoint returns ok"
else
  fail "health endpoint not ok" "$HEALTH"
fi

# Test 2: /prove with canonical France prompt returns valid receipt
PROVE_RESPONSE=$(curl -sS -X POST "http://localhost:$ADAPTER_PORT/prove" \
  -H "Content-Type: application/json" \
  -d '{
    "psec_version":"0x1111111111111111111111111111111111111111111111111111111111111111",
    "model_commitment":"0x2222222222222222222222222222222222222222222222222222222222222222",
    "input_token_ids":[785,6722,315,9625,374],
    "max_output_tokens":20,
    "decoding":"greedy"
  }')

PROVE_HASH=$(echo "$PROVE_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('det_hash', ''))" 2>/dev/null || echo "")
PROVE_FORMAT=$(echo "$PROVE_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('proof_format', ''))" 2>/dev/null || echo "")

if [ -n "$PROVE_HASH" ]; then
  pass "/prove returns det_hash"
else
  fail "/prove missing det_hash" "$PROVE_RESPONSE"
fi

# Test 3: det_hash is correctly formatted (0x + 64 hex)
if echo "$PROVE_HASH" | grep -qE '^0x[0-9a-f]{64}$'; then
  pass "det_hash is 32-byte 0x-prefixed hex (got $PROVE_HASH)"
else
  fail "det_hash format wrong" "$PROVE_HASH"
fi

# Test 4: det_hash starts with PD19's actual hash (padding preserves the value)
EXPECTED_PREFIX="0x${PD19_HASH}"
if [ "${PROVE_HASH:0:18}" = "$EXPECTED_PREFIX" ]; then
  pass "det_hash preserves PD19's hash (prefix=$EXPECTED_PREFIX)"
else
  fail "det_hash doesn't preserve PD19's hash" "expected prefix=$EXPECTED_PREFIX, got=${PROVE_HASH:0:18}"
fi

# Test 5: proof_format is pd19-v1
if [ "$PROVE_FORMAT" = "pd19-v1" ]; then
  pass "proof_format=pd19-v1"
else
  fail "proof_format wrong" "expected pd19-v1, got $PROVE_FORMAT"
fi

# Test 6: psec_version + model_commitment echo back
PROVE_PSEC=$(echo "$PROVE_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('psec_version', ''))")
PROVE_MODEL=$(echo "$PROVE_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('model_commitment', ''))")

if [ "$PROVE_PSEC" = "0x1111111111111111111111111111111111111111111111111111111111111111" ] && \
   [ "$PROVE_MODEL" = "0x2222222222222222222222222222222222222222222222222222222222222222" ]; then
  pass "psec_version and model_commitment echo correctly"
else
  fail "psec/model echo wrong" "psec=$PROVE_PSEC model=$PROVE_MODEL"
fi

# Test 7: unknown token sequence returns 400
UNKNOWN_RESPONSE=$(curl -sS -X POST "http://localhost:$ADAPTER_PORT/prove" \
  -H "Content-Type: application/json" \
  -w "\n%{http_code}" \
  -d '{
    "psec_version":"0x1111",
    "model_commitment":"0x2222",
    "input_token_ids":[1,2,3,4,5],
    "max_output_tokens":20,
    "decoding":"greedy"
  }')
UNKNOWN_STATUS=$(echo "$UNKNOWN_RESPONSE" | tail -n1)

if [ "$UNKNOWN_STATUS" = "400" ]; then
  pass "unknown token sequence rejected with 400"
else
  fail "unknown token sequence not rejected properly" "got status $UNKNOWN_STATUS"
fi

# Test 8: non-greedy decoding rejected
NONGREEDY_RESPONSE=$(curl -sS -X POST "http://localhost:$ADAPTER_PORT/prove" \
  -H "Content-Type: application/json" \
  -w "\n%{http_code}" \
  -d '{
    "psec_version":"0x1111",
    "model_commitment":"0x2222",
    "input_token_ids":[785,6722,315,9625,374],
    "max_output_tokens":20,
    "decoding":"sample"
  }')
NONGREEDY_STATUS=$(echo "$NONGREEDY_RESPONSE" | tail -n1)

if [ "$NONGREEDY_STATUS" = "400" ]; then
  pass "non-greedy decoding rejected with 400"
else
  fail "non-greedy not rejected properly" "got status $NONGREEDY_STATUS"
fi

# ─── Determinism check: two consecutive calls return same hash ─────────────

echo ""
echo "─── determinism check (2 consecutive /prove calls) ───"

PROVE_HASH_2=$(curl -sS -X POST "http://localhost:$ADAPTER_PORT/prove" \
  -H "Content-Type: application/json" \
  -d '{
    "psec_version":"0x1111111111111111111111111111111111111111111111111111111111111111",
    "model_commitment":"0x2222222222222222222222222222222222222222222222222222222222222222",
    "input_token_ids":[785,6722,315,9625,374],
    "max_output_tokens":20,
    "decoding":"greedy"
  }' | python3 -c "import sys,json; print(json.load(sys.stdin).get('det_hash', ''))")

if [ "$PROVE_HASH" = "$PROVE_HASH_2" ]; then
  pass "two consecutive /prove calls return identical det_hash"
else
  fail "non-deterministic" "call1=$PROVE_HASH call2=$PROVE_HASH_2"
fi

# ─── Summary ───────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════"
TOTAL=$((PASS + FAIL))
if [ $FAIL -eq 0 ]; then
  echo "  ✓ PD19 adapter acceptance: $PASS/$TOTAL passed"
  echo ""
  echo "  PD19 hash:        $PD19_HASH (8 bytes, native PD19 format)"
  echo "  Marketplace hash: $PROVE_HASH (32 bytes, padded for marketplace schema)"
  echo "  Backend:          $PD19_BACKEND_LABEL ($PD19_INFER_URL)"
  echo ""
  echo "  Adapter is ready. Point fresh-mode-agent at:"
  echo "    PROVER_ENDPOINT=http://localhost:$ADAPTER_PORT"
  echo "═══════════════════════════════════════════════════════════"
  exit 0
else
  echo "  ✗ PD19 adapter acceptance: $FAIL/$TOTAL FAILED"
  echo "═══════════════════════════════════════════════════════════"
  exit 1
fi
