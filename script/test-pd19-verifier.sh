#!/bin/bash
# Block 6 acceptance.
#
# Validates:
#   1. Both stub-v1 (port 7002) and pd19-v1 (port 7012) verifier services
#      are running and healthy
#   2. Both produce different addresses
#   3. Both are registered on chain under their respective proof_format strings
#   4. Each rejects receipts from the wrong proof_format
#   5. The on-chain registry routes proof_format strings to the correct address

set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$(pwd)"

if [ ! -f "$REPO/.env" ]; then echo "FAIL: $REPO/.env not found"; exit 1; fi
set -a; source "$REPO/.env"; set +a

testNum=0
pass() { testNum=$((testNum+1)); echo "✓ Test $testNum: $1"; }
fail() { testNum=$((testNum+1)); echo "✗ Test $testNum: $1"; [ -n "${2:-}" ] && echo "    $2"; exit 1; }

echo "─── Block 6 acceptance: dual verifier (stub-v1 + pd19-v1) ───"
echo ""

# ─── Test 1: Both verifier services healthy ─────────────────────────────

if curl -sf http://localhost:7002/health >/dev/null 2>&1; then
  pass "stub-v1 verifier on :7002 healthy"
else
  fail "stub-v1 verifier not running on :7002"
fi

if curl -sf http://localhost:7012/health >/dev/null 2>&1; then
  pass "pd19-v1 verifier on :7012 healthy"
else
  fail "pd19-v1 verifier not running on :7012 — run setup-pd19-verifier.sh first"
fi

# ─── Test 2: Both verifiers report their distinct proof formats ─────────

STUB_FORMAT=$(curl -s http://localhost:7002/health | python3 -c "import sys,json; print(json.load(sys.stdin).get('proof_format',''))")
PD19_FORMAT=$(curl -s http://localhost:7012/health | python3 -c "import sys,json; print(json.load(sys.stdin).get('proof_format',''))")

if [ "$STUB_FORMAT" = "stub-v1" ]; then pass "stub verifier reports proof_format=stub-v1"
else fail "stub verifier reports wrong format" "got: $STUB_FORMAT"; fi

if [ "$PD19_FORMAT" = "pd19-v1" ]; then pass "pd19 verifier reports proof_format=pd19-v1"
else fail "pd19 verifier reports wrong format" "got: $PD19_FORMAT"; fi

# ─── Test 3: Different addresses ────────────────────────────────────────

STUB_ADDR=$(curl -s http://localhost:7002/address | python3 -c "import sys,json; print(json.load(sys.stdin)['verifier_address'])")
PD19_ADDR=$(curl -s http://localhost:7012/address | python3 -c "import sys,json; print(json.load(sys.stdin)['verifier_address'])")

if [ "${STUB_ADDR,,}" != "${PD19_ADDR,,}" ]; then
  pass "stub-v1 and pd19-v1 verifier addresses are distinct"
  echo "    stub-v1: $STUB_ADDR"
  echo "    pd19-v1: $PD19_ADDR"
else
  fail "verifiers share an address (config error)" "both: $STUB_ADDR"
fi

# ─── Test 4: On-chain registration ──────────────────────────────────────

ON_CHAIN_STUB=$(cast call "$VERIFIER_REGISTRY_ADDR" \
  "getVerifier(string)(address)" "stub-v1" \
  --rpc-url "$ZERO_G_RPC_URL" 2>/dev/null || echo "")
ON_CHAIN_PD19=$(cast call "$VERIFIER_REGISTRY_ADDR" \
  "getVerifier(string)(address)" "pd19-v1" \
  --rpc-url "$ZERO_G_RPC_URL" 2>/dev/null || echo "")

if [ "${ON_CHAIN_STUB,,}" = "${STUB_ADDR,,}" ]; then
  pass "on-chain registry: stub-v1 → $STUB_ADDR"
else
  fail "stub-v1 not registered correctly" "registry: $ON_CHAIN_STUB, expected: $STUB_ADDR"
fi

if [ "${ON_CHAIN_PD19,,}" = "${PD19_ADDR,,}" ]; then
  pass "on-chain registry: pd19-v1 → $PD19_ADDR"
else
  fail "pd19-v1 not registered correctly" "registry: $ON_CHAIN_PD19, expected: $PD19_ADDR"
fi

# ─── Test 5: Each verifier rejects the wrong proof_format ───────────────

# Build a fake stub-v1 receipt (the prover-stub's canonical France output)
STUB_RECEIPT='{"psec_version":"0x1111111111111111111111111111111111111111111111111111111111111111","model_commitment":"0x2222222222222222222222222222222222222222222222222222222222222222","input_token_ids":[785,6722,315,9625,374],"output_token_ids":[12095,13,576,6722,315,17689,374,24081,13,576,6722,315,15344,374,21718,13,576,6722,315,9856],"det_hash":"0x6b64b51afe77ff67bb4336117f89237090ff9ba41d7a2c2ad2c0646ef8b44336","proof_blob":"0x6b64b51afe77ff67bb4336117f89237090ff9ba41d7a2c2ad2c0646ef8b44336","proof_format":"stub-v1"}'

# Send stub-v1 receipt to pd19-v1 verifier (should reject)
PD19_REJECT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://localhost:7012/attest \
  -H "Content-Type: application/json" \
  -d "{\"receipt\":$STUB_RECEIPT,\"tier\":1}")

if [ "$PD19_REJECT_STATUS" = "400" ]; then
  pass "pd19-v1 verifier rejects stub-v1 receipt (status 400)"
else
  fail "pd19-v1 verifier did not reject wrong format" "got status $PD19_REJECT_STATUS"
fi

# Build a fake pd19-v1 receipt (same canonical hash, different format tag)
PD19_RECEIPT='{"psec_version":"0x1111111111111111111111111111111111111111111111111111111111111111","model_commitment":"0x2222222222222222222222222222222222222222222222222222222222222222","input_token_ids":[785,6722,315,9625,374],"output_token_ids":[12095,13,576,6722,315,17689,374,24081,13,576,6722,315,15344,374,21718,13,576,6722,315,9856],"det_hash":"0x6b64b51afe77ff67bb4336117f89237090ff9ba41d7a2c2ad2c0646ef8b44336","proof_blob":"0x6b64b51afe77ff67bb4336117f89237090ff9ba41d7a2c2ad2c0646ef8b44336","proof_format":"pd19-v1"}'

# Send pd19-v1 receipt to stub-v1 verifier (should reject)
STUB_REJECT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://localhost:7002/attest \
  -H "Content-Type: application/json" \
  -d "{\"receipt\":$PD19_RECEIPT,\"tier\":1}")

if [ "$STUB_REJECT_STATUS" = "400" ]; then
  pass "stub-v1 verifier rejects pd19-v1 receipt (status 400)"
else
  fail "stub-v1 verifier did not reject wrong format" "got status $STUB_REJECT_STATUS"
fi

# ─── Test 6: pd19-v1 signs valid pd19-v1 receipt ────────────────────────

PD19_SIG_RESPONSE=$(curl -s -X POST http://localhost:7012/attest \
  -H "Content-Type: application/json" \
  -d "{\"receipt\":$PD19_RECEIPT,\"tier\":1}")

PD19_VALID=$(echo "$PD19_SIG_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('valid'))")
PD19_SIG_ADDR=$(echo "$PD19_SIG_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('verifier_address',''))")

if [ "$PD19_VALID" = "True" ]; then
  pass "pd19-v1 verifier signs valid pd19-v1 receipt"
else
  fail "pd19-v1 verifier rejected valid receipt" "$PD19_SIG_RESPONSE"
fi

if [ "${PD19_SIG_ADDR,,}" = "${PD19_ADDR,,}" ]; then
  pass "pd19-v1 signature reports correct verifier_address"
else
  fail "pd19-v1 signature has wrong address" "got $PD19_SIG_ADDR, expected $PD19_ADDR"
fi

# ─── Summary ────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ✓ Block 6 acceptance: $testNum/$testNum tests passed"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  Two verifiers running, two on-chain registry entries:"
echo "    stub-v1 → $STUB_ADDR (port 7002)"
echo "    pd19-v1 → $PD19_ADDR (port 7012)"
echo ""
echo "  Each rejects the other's proof_format. Multi-format marketplace works."
