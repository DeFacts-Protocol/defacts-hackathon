#!/bin/bash
# Threshold-stub acceptance test. Self-contained — no other services needed.
# Tests the ECIES wrap/unwrap roundtrip plus payment_proof gating.

set -e

THRESHOLD=http://localhost:7003

echo "=== Test 1: /health ==="
curl -s $THRESHOLD/health | jq .
echo ""

echo "=== Test 2: /keypair-for-test (generate buyer keypair) ==="
KEYPAIR=$(curl -s -X POST $THRESHOLD/keypair-for-test)
echo "$KEYPAIR" | jq .
BUYER_PRIVKEY=$(echo "$KEYPAIR" | jq -r .private_key)
BUYER_PUBKEY=$(echo "$KEYPAIR" | jq -r .public_key_compressed)
echo "buyer privkey: $BUYER_PRIVKEY"
echo "buyer pubkey:  $BUYER_PUBKEY"
echo ""

# Build a fake receipt that looks like what the prover-stub produces
RECEIPT='{"psec_version":"0x1111111111111111111111111111111111111111111111111111111111111111","model_commitment":"0x2222222222222222222222222222222222222222222222222222222222222222","input_token_ids":[785,6722,315,9625,374],"output_token_ids":[12095,13,576,6722,315,17689,374,24081,13,576,6722,315,15344,374,21718,13,576,6722,315,9856],"det_hash":"0x6b64b51afe77ff67bb4336117f89237090ff9ba41d7a2c2ad2c0646ef8b44336","proof_blob":"0x6b64b51afe77ff67bb4336117f89237090ff9ba41d7a2c2ad2c0646ef8b44336","proof_format":"stub-v1"}'

echo "=== Test 3: /wrap with valid payment_proof ==="
WRAP_RESP=$(curl -s -X POST $THRESHOLD/wrap \
  -H "Content-Type: application/json" \
  -d "{\"receipt\":$RECEIPT,\"buyer_pubkey\":\"$BUYER_PUBKEY\",\"payment_proof\":\"stub-paid\",\"trade_id\":\"0xtrade1\"}")
echo "$WRAP_RESP" | jq .
CIPHERTEXT=$(echo "$WRAP_RESP" | jq -r .ciphertext)
if [ "$CIPHERTEXT" = "null" ] || [ -z "$CIPHERTEXT" ]; then echo "FAIL: no ciphertext returned"; exit 1; fi
echo "PASS: receipt wrapped, ciphertext length: ${#CIPHERTEXT}"
echo ""

echo "=== Test 4: /unwrap with correct buyer privkey roundtrips ==="
UNWRAP_RESP=$(curl -s -X POST $THRESHOLD/unwrap \
  -H "Content-Type: application/json" \
  -d "{\"ciphertext\":\"$CIPHERTEXT\",\"buyer_privkey\":\"$BUYER_PRIVKEY\"}")
echo "$UNWRAP_RESP" | jq .
RECOVERED_DETHASH=$(echo "$UNWRAP_RESP" | jq -r .receipt.det_hash)
if [ "$RECOVERED_DETHASH" = "0x6b64b51afe77ff67bb4336117f89237090ff9ba41d7a2c2ad2c0646ef8b44336" ]; then
  echo "PASS: unwrap recovers original receipt (det_hash matches)"
else
  echo "FAIL: roundtrip failed. recovered det_hash: $RECOVERED_DETHASH"
  exit 1
fi
echo ""

echo "=== Test 5: /unwrap with WRONG privkey fails ==="
WRONG_KEYPAIR=$(curl -s -X POST $THRESHOLD/keypair-for-test)
WRONG_PRIVKEY=$(echo "$WRONG_KEYPAIR" | jq -r .private_key)
WRONG_RESP=$(curl -s -X POST $THRESHOLD/unwrap \
  -H "Content-Type: application/json" \
  -d "{\"ciphertext\":\"$CIPHERTEXT\",\"buyer_privkey\":\"$WRONG_PRIVKEY\"}")
echo "$WRONG_RESP" | jq .
WRONG_ERR=$(echo "$WRONG_RESP" | jq -r .error)
if [[ "$WRONG_ERR" == *"decryption failed"* ]]; then
  echo "PASS: wrong privkey rejected"
else
  echo "FAIL: wrong privkey did NOT fail decryption"
  exit 1
fi
echo ""

echo "=== Test 6: /wrap WITHOUT valid payment_proof rejected (402) ==="
NOPAY_RESP=$(curl -s -w "\n%{http_code}" -X POST $THRESHOLD/wrap \
  -H "Content-Type: application/json" \
  -d "{\"receipt\":$RECEIPT,\"buyer_pubkey\":\"$BUYER_PUBKEY\",\"payment_proof\":\"forged\",\"trade_id\":\"0xtrade2\"}")
NOPAY_CODE=$(echo "$NOPAY_RESP" | tail -1)
NOPAY_BODY=$(echo "$NOPAY_RESP" | head -n -1)
echo "$NOPAY_BODY" | jq .
echo "HTTP code: $NOPAY_CODE"
if [ "$NOPAY_CODE" = "402" ]; then
  echo "PASS: forged payment_proof rejected with 402 Payment Required"
else
  echo "FAIL: expected 402, got $NOPAY_CODE"
  exit 1
fi
echo ""

echo "=== Test 7: /wrap missing fields rejected ==="
MISSING_RESP=$(curl -s -w "\n%{http_code}" -X POST $THRESHOLD/wrap \
  -H "Content-Type: application/json" \
  -d "{\"receipt\":$RECEIPT,\"buyer_pubkey\":\"$BUYER_PUBKEY\"}")
MISSING_CODE=$(echo "$MISSING_RESP" | tail -1)
MISSING_BODY=$(echo "$MISSING_RESP" | head -n -1)
echo "$MISSING_BODY" | jq .
if [ "$MISSING_CODE" = "400" ]; then
  echo "PASS: missing payment_proof rejected"
else
  echo "FAIL: expected 400, got $MISSING_CODE"
  exit 1
fi
echo ""

echo "=== Test 8: ciphertext varies per call (ECIES uses fresh ephemeral key) ==="
WRAP_2=$(curl -s -X POST $THRESHOLD/wrap \
  -H "Content-Type: application/json" \
  -d "{\"receipt\":$RECEIPT,\"buyer_pubkey\":\"$BUYER_PUBKEY\",\"payment_proof\":\"stub-paid\",\"trade_id\":\"0xtrade3\"}")
CIPHERTEXT_2=$(echo "$WRAP_2" | jq -r .ciphertext)
if [ "$CIPHERTEXT" != "$CIPHERTEXT_2" ]; then
  echo "PASS: same input produces different ciphertext (semantic security)"
else
  echo "FAIL: ECIES not using fresh ephemeral keys — semantic security broken"
  exit 1
fi
echo ""

echo "=== Test 9: both ciphertexts decrypt to the same receipt ==="
UNWRAP_2=$(curl -s -X POST $THRESHOLD/unwrap \
  -H "Content-Type: application/json" \
  -d "{\"ciphertext\":\"$CIPHERTEXT_2\",\"buyer_privkey\":\"$BUYER_PRIVKEY\"}")
DETHASH_2=$(echo "$UNWRAP_2" | jq -r .receipt.det_hash)
if [ "$DETHASH_2" = "0x6b64b51afe77ff67bb4336117f89237090ff9ba41d7a2c2ad2c0646ef8b44336" ]; then
  echo "PASS: second ciphertext also decrypts to original receipt"
else
  echo "FAIL: second decryption produced wrong det_hash: $DETHASH_2"
  exit 1
fi
echo ""

echo "================================="
echo "ALL ACCEPTANCE TESTS PASSED (9/9)"
echo "================================="
echo ""
echo "ECIES wrap/unwrap roundtrip works. Payment-gating logic works."
echo "On Day 4, replace isPaymentValid() with on-chain Tier2Settled event watcher."
