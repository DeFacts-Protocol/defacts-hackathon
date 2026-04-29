#!/bin/bash
# Prover-stub acceptance test. Run while server.mjs is running on :7001.
set -e

PROVER=http://localhost:7001
PSEC_VERSION="0x$(printf '11%.0s' {1..32})"
MODEL_COMMITMENT="0x$(printf '22%.0s' {1..32})"

echo "=== Test 1: /health ==="
curl -s $PROVER/health | jq .
echo ""

echo "=== Test 2: /prove with canonical France prompt ==="
PROVE_RESP=$(curl -s -X POST $PROVER/prove \
  -H "Content-Type: application/json" \
  -d "{\"psec_version\":\"$PSEC_VERSION\",\"model_commitment\":\"$MODEL_COMMITMENT\",\"input_token_ids\":[785,6722,315,9625,374],\"max_output_tokens\":20,\"decoding\":\"greedy\"}")
echo "$PROVE_RESP" | jq .
DET_HASH=$(echo "$PROVE_RESP" | jq -r .det_hash)
OUTPUT_IDS=$(echo "$PROVE_RESP" | jq -c .output_token_ids)
echo "captured det_hash: $DET_HASH"
echo ""

echo "=== Test 3: deterministic - same input gives same hash ==="
PROVE_RESP_2=$(curl -s -X POST $PROVER/prove \
  -H "Content-Type: application/json" \
  -d "{\"psec_version\":\"$PSEC_VERSION\",\"model_commitment\":\"$MODEL_COMMITMENT\",\"input_token_ids\":[785,6722,315,9625,374],\"max_output_tokens\":20,\"decoding\":\"greedy\"}")
DET_HASH_2=$(echo "$PROVE_RESP_2" | jq -r .det_hash)
if [ "$DET_HASH" = "$DET_HASH_2" ]; then
  echo "PASS: same hash on second call"
else
  echo "FAIL: DETERMINISM BROKEN"; exit 1
fi
echo ""

echo "=== Test 4: /verify with valid receipt ==="
VERIFY_RESP=$(curl -s -X POST $PROVER/verify \
  -H "Content-Type: application/json" \
  -d "{\"psec_version\":\"$PSEC_VERSION\",\"model_commitment\":\"$MODEL_COMMITMENT\",\"input_token_ids\":[785,6722,315,9625,374],\"output_token_ids\":$OUTPUT_IDS,\"det_hash\":\"$DET_HASH\",\"proof_format\":\"stub-v1\"}")
echo "$VERIFY_RESP" | jq .
VALID=$(echo "$VERIFY_RESP" | jq -r .valid)
if [ "$VALID" = "true" ]; then echo "PASS: valid receipt accepted"; else echo "FAIL: VALID RECEIPT REJECTED"; exit 1; fi
echo ""

echo "=== Test 5: /verify with tampered det_hash ==="
TAMPERED_HASH="${DET_HASH%?}0"
if [ "$TAMPERED_HASH" = "$DET_HASH" ]; then TAMPERED_HASH="${DET_HASH%?}1"; fi
TAMPER_RESP=$(curl -s -X POST $PROVER/verify \
  -H "Content-Type: application/json" \
  -d "{\"psec_version\":\"$PSEC_VERSION\",\"model_commitment\":\"$MODEL_COMMITMENT\",\"input_token_ids\":[785,6722,315,9625,374],\"output_token_ids\":$OUTPUT_IDS,\"det_hash\":\"$TAMPERED_HASH\",\"proof_format\":\"stub-v1\"}")
echo "$TAMPER_RESP" | jq .
TAMPER_VALID=$(echo "$TAMPER_RESP" | jq -r .valid)
if [ "$TAMPER_VALID" = "false" ]; then echo "PASS: tampered hash rejected"; else echo "FAIL: TAMPERED HASH ACCEPTED"; exit 1; fi
echo ""

echo "=== Test 6: /verify with tampered output_ids ==="
TAMPER2_RESP=$(curl -s -X POST $PROVER/verify \
  -H "Content-Type: application/json" \
  -d "{\"psec_version\":\"$PSEC_VERSION\",\"model_commitment\":\"$MODEL_COMMITMENT\",\"input_token_ids\":[785,6722,315,9625,374],\"output_token_ids\":[12095,99,99,99,99],\"det_hash\":\"$DET_HASH\",\"proof_format\":\"stub-v1\"}")
echo "$TAMPER2_RESP" | jq .
TAMPER2_VALID=$(echo "$TAMPER2_RESP" | jq -r .valid)
if [ "$TAMPER2_VALID" = "false" ]; then echo "PASS: tampered output rejected"; else echo "FAIL: TAMPERED OUTPUT ACCEPTED"; exit 1; fi
echo ""

echo "================================="
echo "ALL ACCEPTANCE TESTS PASSED (6/6)"
echo "================================="
echo ""
echo "Captured det_hash for canonical France prompt: $DET_HASH"
echo "(stub-v1 hash - different from real PSEC's 0x7890...)"
