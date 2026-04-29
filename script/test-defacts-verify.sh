#!/bin/bash
# Block 7 acceptance.
#
# Validates the defacts-verify CLI against:
#   1. A synthetic receipt JSON (built fresh, deterministic) — confirms the
#      CLI logic is correct without depending on Block 5's run output
#   2. The real Block 5 output receipt (if it exists) — confirms the CLI
#      verifies receipts produced by the actual marketplace
#
# Three modes tested per receipt:
#   --alice : should exit 0 (VALID)
#   --carol : should exit 1 (INVALID)
#   --pubkey 0x...random... : should exit 1 (INVALID — substitution)

set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$(pwd)"
echo "─── Block 7 acceptance: defacts-verify CLI ───"
echo ""

if [ ! -f "$REPO/.env" ]; then echo "FAIL: $REPO/.env not found"; exit 1; fi
set -a; source "$REPO/.env"; set +a

CLI="$REPO/script/defacts-verify.mjs"
if [ ! -f "$CLI" ]; then echo "FAIL: $CLI not found"; exit 1; fi

testNum=0
pass() { testNum=$((testNum+1)); echo "✓ Test $testNum: $1"; }
fail() { testNum=$((testNum+1)); echo "✗ Test $testNum: $1"; [ -n "${2:-}" ] && echo "    $2"; exit 1; }

# ─── Test 1: Synthetic receipt (built fresh) ────────────────────────────

# Build a fresh receipt by signing one with the verifier-stub.
# The verifier-stub at :7002 is signing as stub-v1, but we need a Tier 2
# attestation. Make a /attest call directly.

if ! curl -sf http://localhost:7002/health >/dev/null; then
  fail "stub-v1 verifier on :7002 not running" "start it first"
fi

# Buyer pubkey: derive from WALLET_PRIVKEY (same as user-runtime does).
# Run this node call from inside script/ so viem is resolvable from
# script/node_modules.
ALICE_PUBKEY=$(cd "$REPO/script" && node -e "
import('viem/accounts').then(({ privateKeyToAccount }) => {
  const acc = privateKeyToAccount('$WALLET_PRIVKEY');
  console.log(acc.publicKey);
});
")
if [ -z "$ALICE_PUBKEY" ] || [ "${ALICE_PUBKEY:0:2}" != "0x" ]; then
  fail "could not derive ALICE_PUBKEY" "got: $ALICE_PUBKEY"
fi
echo "  Alice pubkey: ${ALICE_PUBKEY:0:30}..."

# Canonical France receipt
SYNTHETIC_RECEIPT='{
  "psec_version": "0x1111111111111111111111111111111111111111111111111111111111111111",
  "model_commitment": "0x2222222222222222222222222222222222222222222222222222222222222222",
  "input_token_ids": [785,6722,315,9625,374],
  "output_token_ids": [12095,13,576,6722,315,17689,374,24081,13,576,6722,315,15344,374,21718,13,576,6722,315,9856],
  "det_hash": "0x6b64b51afe77ff67bb4336117f89237090ff9ba41d7a2c2ad2c0646ef8b44336",
  "proof_blob": "0x6b64b51afe77ff67bb4336117f89237090ff9ba41d7a2c2ad2c0646ef8b44336",
  "proof_format": "stub-v1"
}'

# Get a Tier 2 attestation from verifier-stub
ATTEST_BODY="{\"receipt\":$SYNTHETIC_RECEIPT,\"tier\":2,\"buyer_pubkey\":\"$ALICE_PUBKEY\"}"
ATTEST_RESPONSE=$(curl -s -X POST http://localhost:7002/attest \
  -H "Content-Type: application/json" \
  -d "$ATTEST_BODY")

VALID=$(echo "$ATTEST_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('valid'))")
if [ "$VALID" != "True" ]; then
  fail "could not get Tier 2 attestation from verifier-stub" "$ATTEST_RESPONSE"
fi
pass "obtained fresh Tier 2 attestation from verifier-stub"

# Build the receipt JSON in the format Block 5's runtime writes
SYNTH_OUTPUT_DIR=$(mktemp -d)
SYNTH_RECEIPT_PATH="$SYNTH_OUTPUT_DIR/synthetic.json"

python3 > "$SYNTH_RECEIPT_PATH" <<EOF
import json, sys
attest = json.loads('''$ATTEST_RESPONSE''')
out = {
    "version": "defacts-receipt-v1",
    "trade_id": "0x" + "ab"*32,
    "psec_version": "0x" + "11"*32,
    "model_commitment": "0x" + "22"*32,
    "input": {"token_ids": [785,6722,315,9625,374]},
    "output": {"token_ids": [12095,13,576,6722,315,17689,374,24081,13,576,6722,315,15344,374,21718,13,576,6722,315,9856]},
    "det_hash": "0x6b64b51afe77ff67bb4336117f89237090ff9ba41d7a2c2ad2c0646ef8b44336",
    "proof_format": "stub-v1",
    "proof_blob": "0x6b64b51afe77ff67bb4336117f89237090ff9ba41d7a2c2ad2c0646ef8b44336",
    "verifier_attestation": {
        "tier": 2,
        "verifier_address": attest["verifier_address"],
        "buyer_pubkey": "$ALICE_PUBKEY",
        "signature": attest["signature"],
        "signed_at": attest["signed_at"],
        "input_hash": attest["input_hash"],
        "output_hash": attest["output_hash"]
    },
    "metadata": {"chain_id": 16602, "escrow_addr": "$ESCROW_ADDR"}
}
print(json.dumps(out, indent=2))
EOF

pass "built synthetic receipt at $SYNTH_RECEIPT_PATH"

# ─── Test 2: --alice mode = VALID ───────────────────────────────────────

set +e
node "$CLI" "$SYNTH_RECEIPT_PATH" --alice >"$SYNTH_OUTPUT_DIR/alice.txt" 2>&1
RC_ALICE=$?
set -e

if [ $RC_ALICE -eq 0 ]; then
  pass "synthetic --alice exits 0 (VALID)"
else
  echo "    output:"
  sed 's/^/      /' "$SYNTH_OUTPUT_DIR/alice.txt"
  fail "synthetic --alice should have been valid" "exit code: $RC_ALICE"
fi

if grep -q "V A L I D" "$SYNTH_OUTPUT_DIR/alice.txt"; then
  pass "synthetic --alice shows VALID banner"
else
  fail "VALID banner missing"
fi

# ─── Test 3: --carol mode = INVALID ─────────────────────────────────────

set +e
node "$CLI" "$SYNTH_RECEIPT_PATH" --carol >"$SYNTH_OUTPUT_DIR/carol.txt" 2>&1
RC_CAROL=$?
set -e

if [ $RC_CAROL -eq 1 ]; then
  pass "synthetic --carol exits 1 (INVALID)"
else
  echo "    output:"
  sed 's/^/      /' "$SYNTH_OUTPUT_DIR/carol.txt"
  fail "synthetic --carol should have been invalid" "exit code: $RC_CAROL"
fi

if grep -q "I N V A L I D" "$SYNTH_OUTPUT_DIR/carol.txt"; then
  pass "synthetic --carol shows INVALID banner"
else
  fail "INVALID banner missing"
fi

# Verify Carol mode actually shows a DIFFERENT recovered signer
RECOVERED_CAROL=$(grep "Recovered signer:" "$SYNTH_OUTPUT_DIR/carol.txt" | awk '{print $NF}')
EXPECTED=$(grep "Verifier (chain):" "$SYNTH_OUTPUT_DIR/carol.txt" | awk '{print $NF}')
if [ "${RECOVERED_CAROL,,}" != "${EXPECTED,,}" ]; then
  pass "synthetic --carol: recovered signer differs from verifier"
  echo "    recovered: $RECOVERED_CAROL"
  echo "    expected:  $EXPECTED"
else
  fail "carol mode did not change the recovered signer (CLI bug)"
fi

# ─── Test 4: --pubkey custom = INVALID ──────────────────────────────────

# Use a third random pubkey (Carol's pubkey + 1, not derived from a real key)
RANDOM_PUBKEY="0x04$(openssl rand -hex 64)"

set +e
node "$CLI" "$SYNTH_RECEIPT_PATH" --pubkey "$RANDOM_PUBKEY" >"$SYNTH_OUTPUT_DIR/random.txt" 2>&1
RC_RAND=$?
set -e

if [ $RC_RAND -eq 1 ]; then
  pass "synthetic --pubkey <random> exits 1 (INVALID)"
else
  fail "synthetic --pubkey <random> should have been invalid" "exit code: $RC_RAND"
fi

# ─── Test 5: Block 5's real receipt (if present) ────────────────────────

# Find the most recent receipt JSON from the user-runtime test output
RECEIPTS_DIR="$REPO/agents/user/test/output"
if [ -d "$RECEIPTS_DIR" ]; then
  LATEST_RECEIPT=$(ls -t "$RECEIPTS_DIR"/receipt-*.json 2>/dev/null | head -1)
  if [ -n "$LATEST_RECEIPT" ]; then
    pass "found Block 5 receipt: $LATEST_RECEIPT"

    set +e
    node "$CLI" "$LATEST_RECEIPT" --alice >"$SYNTH_OUTPUT_DIR/real-alice.txt" 2>&1
    RC_RA=$?
    set -e

    if [ $RC_RA -eq 0 ]; then
      pass "Block 5 receipt --alice exits 0 (VALID)"
    else
      echo "    output:"
      sed 's/^/      /' "$SYNTH_OUTPUT_DIR/real-alice.txt"
      fail "Block 5 receipt --alice failed" "exit: $RC_RA"
    fi

    set +e
    node "$CLI" "$LATEST_RECEIPT" --carol >"$SYNTH_OUTPUT_DIR/real-carol.txt" 2>&1
    RC_RC=$?
    set -e

    if [ $RC_RC -eq 1 ]; then
      pass "Block 5 receipt --carol exits 1 (INVALID)"
    else
      fail "Block 5 receipt --carol should have been invalid" "exit: $RC_RC"
    fi
  else
    echo "  (no Block 5 receipt found in $RECEIPTS_DIR — skipping real-receipt tests)"
  fi
else
  echo "  (Block 5 output dir does not exist — skipping real-receipt tests)"
fi

# ─── Summary ────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ✓ Block 7 acceptance: $testNum/$testNum tests passed"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  defacts-verify CLI demonstrated:"
echo "    --alice  → VALID    (signature recovers to verifier)"
echo "    --carol  → INVALID  (different pubkey → different digest)"
echo "    --pubkey → INVALID  (any non-Alice substitution fails)"
echo ""
echo "  This is the demo's Act 5 ('Non-resale')."
echo "  The receipt is cryptographically bound to Alice's identity."
echo "  Carol cannot verify under her own pubkey, no matter what."
echo ""

# Cleanup synthetic dir
rm -rf "$SYNTH_OUTPUT_DIR"
