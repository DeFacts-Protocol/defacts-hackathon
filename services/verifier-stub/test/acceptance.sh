#!/bin/bash
# Verifier-stub acceptance test. Requires:
#   - prover-stub running on :7001
#   - verifier-stub running on :7002 with VERIFIER_PRIVKEY set
#
# Validates the full pipeline: prover gives a receipt, verifier validates
# it via prover, signs an EIP-712 attestation, and the signature recovers
# to the verifier's address.

set -e

PROVER=http://localhost:7001
VERIFIER=http://localhost:7002
PSEC_VERSION="0x$(printf '11%.0s' {1..32})"
MODEL_COMMITMENT="0x$(printf '22%.0s' {1..32})"

echo "=== Test 1: /health ==="
HEALTH=$(curl -s $VERIFIER/health)
echo "$HEALTH" | jq .
VERIFIER_ADDR=$(echo "$HEALTH" | jq -r .verifier_address)
echo "verifier address: $VERIFIER_ADDR"
echo ""

echo "=== Test 2: /address (convenience for cast scripts) ==="
curl -s $VERIFIER/address | jq .
echo ""

echo "=== Test 3: get a fresh receipt from prover-stub ==="
RECEIPT=$(curl -s -X POST $PROVER/prove \
  -H "Content-Type: application/json" \
  -d "{\"psec_version\":\"$PSEC_VERSION\",\"model_commitment\":\"$MODEL_COMMITMENT\",\"input_token_ids\":[785,6722,315,9625,374],\"max_output_tokens\":20,\"decoding\":\"greedy\"}")
echo "$RECEIPT" | jq .
DET_HASH=$(echo "$RECEIPT" | jq -r .det_hash)
echo ""

# Build a "full receipt" the verifier expects. The prover returns it almost
# complete; we just rename input_token_ids since the prover already returns
# matching field names.
RECEIPT_FULL=$(jq -n \
  --argjson outputs "$(echo $RECEIPT | jq .output_token_ids)" \
  --arg dethash "$DET_HASH" \
  --arg psec "$PSEC_VERSION" \
  --arg model "$MODEL_COMMITMENT" \
  '{
    psec_version: $psec,
    model_commitment: $model,
    input_token_ids: [785,6722,315,9625,374],
    output_token_ids: $outputs,
    det_hash: $dethash,
    proof_format: "stub-v1",
    proof_blob: $dethash
  }')

echo "=== Test 4: /attest with valid Tier 1 receipt ==="
TIER1_RESP=$(curl -s -X POST $VERIFIER/attest \
  -H "Content-Type: application/json" \
  -d "{\"receipt\":$RECEIPT_FULL,\"tier\":1}")
echo "$TIER1_RESP" | jq .
TIER1_VALID=$(echo "$TIER1_RESP" | jq -r .valid)
TIER1_SIG=$(echo "$TIER1_RESP" | jq -r .signature)
TIER1_INPUT_HASH=$(echo "$TIER1_RESP" | jq -r .input_hash)
TIER1_OUTPUT_HASH=$(echo "$TIER1_RESP" | jq -r .output_hash)
if [ "$TIER1_VALID" != "true" ]; then echo "FAIL: Tier 1 attestation rejected"; exit 1; fi
echo "PASS: Tier 1 attestation signed"
echo ""

echo "=== Test 5: input_hash + output_hash match canonical France values ==="
EXPECTED_INPUT_HASH="0x05c0be0a90d620aaa058e271a2d96610aa364b818ddd48dd7db44a62b398ae4f"
EXPECTED_OUTPUT_HASH="0x6885e4e69b852f544e263d63bbdb73716a2524ba0e9abc69527ad6f4cef18aba"
if [ "$TIER1_INPUT_HASH" = "$EXPECTED_INPUT_HASH" ]; then
  echo "PASS: input_hash matches canonical $EXPECTED_INPUT_HASH"
else
  echo "FAIL: input_hash mismatch"
  echo "  got:      $TIER1_INPUT_HASH"
  echo "  expected: $EXPECTED_INPUT_HASH"
  exit 1
fi
if [ "$TIER1_OUTPUT_HASH" = "$EXPECTED_OUTPUT_HASH" ]; then
  echo "PASS: output_hash matches canonical $EXPECTED_OUTPUT_HASH"
else
  echo "FAIL: output_hash mismatch"
  echo "  got:      $TIER1_OUTPUT_HASH"
  echo "  expected: $EXPECTED_OUTPUT_HASH"
  exit 1
fi
echo ""

echo "=== Test 6: Tier 1 signature recovers to verifier_address ==="
# Use Node + viem to recover. We're checking the same math that Escrow.sol
# will run. If recovery here works, recovery on-chain works.
node --input-type=module -e "
import { recoverTypedDataAddress } from 'viem';
const sig = '$TIER1_SIG';
const verifierAddr = '$VERIFIER_ADDR';
const escrowAddr = '$(echo $HEALTH | jq -r .escrow_addr)';
const chainId = $(echo $HEALTH | jq -r .chain_id);
const recovered = await recoverTypedDataAddress({
  domain: { name: 'DeFacts', version: '1', chainId, verifyingContract: escrowAddr },
  types: {
    Tier1Attestation: [
      { name: 'psec_version', type: 'bytes32' },
      { name: 'model_commitment', type: 'bytes32' },
      { name: 'input_hash', type: 'bytes32' },
      { name: 'output_hash', type: 'bytes32' },
      { name: 'tier', type: 'uint8' },
    ],
  },
  primaryType: 'Tier1Attestation',
  message: {
    psec_version: '$PSEC_VERSION',
    model_commitment: '$MODEL_COMMITMENT',
    input_hash: '$TIER1_INPUT_HASH',
    output_hash: '$TIER1_OUTPUT_HASH',
    tier: 1,
  },
  signature: sig,
});
if (recovered.toLowerCase() === verifierAddr.toLowerCase()) {
  console.log('PASS: signature recovers to', recovered);
} else {
  console.error('FAIL: recovered', recovered, 'expected', verifierAddr);
  process.exit(1);
}
"
echo ""

echo "=== Test 7: /attest with valid Tier 2 receipt ==="
BUYER_PUBKEY="0x02$(printf 'cd%.0s' {1..32})"
TIER2_RESP=$(curl -s -X POST $VERIFIER/attest \
  -H "Content-Type: application/json" \
  -d "{\"receipt\":$RECEIPT_FULL,\"tier\":2,\"buyer_pubkey\":\"$BUYER_PUBKEY\"}")
echo "$TIER2_RESP" | jq .
TIER2_VALID=$(echo "$TIER2_RESP" | jq -r .valid)
TIER2_SIG=$(echo "$TIER2_RESP" | jq -r .signature)
if [ "$TIER2_VALID" != "true" ]; then echo "FAIL: Tier 2 attestation rejected"; exit 1; fi
echo "PASS: Tier 2 attestation signed"
echo ""

echo "=== Test 8: Tier 2 signature recovers to verifier_address ==="
node --input-type=module -e "
import { recoverTypedDataAddress } from 'viem';
const sig = '$TIER2_SIG';
const verifierAddr = '$VERIFIER_ADDR';
const escrowAddr = '$(echo $HEALTH | jq -r .escrow_addr)';
const chainId = $(echo $HEALTH | jq -r .chain_id);
const recovered = await recoverTypedDataAddress({
  domain: { name: 'DeFacts', version: '1', chainId, verifyingContract: escrowAddr },
  types: {
    Tier2Attestation: [
      { name: 'psec_version', type: 'bytes32' },
      { name: 'model_commitment', type: 'bytes32' },
      { name: 'input_hash', type: 'bytes32' },
      { name: 'output_hash', type: 'bytes32' },
      { name: 'tier', type: 'uint8' },
      { name: 'buyer_pubkey', type: 'bytes' },
    ],
  },
  primaryType: 'Tier2Attestation',
  message: {
    psec_version: '$PSEC_VERSION',
    model_commitment: '$MODEL_COMMITMENT',
    input_hash: '$TIER1_INPUT_HASH',
    output_hash: '$TIER1_OUTPUT_HASH',
    tier: 2,
    buyer_pubkey: '$BUYER_PUBKEY',
  },
  signature: sig,
});
if (recovered.toLowerCase() === verifierAddr.toLowerCase()) {
  console.log('PASS: Tier 2 signature recovers to', recovered);
} else {
  console.error('FAIL: recovered', recovered, 'expected', verifierAddr);
  process.exit(1);
}
"
echo ""

echo "=== Test 9: Tier 2 signature differs from Tier 1 (binding works) ==="
if [ "$TIER1_SIG" != "$TIER2_SIG" ]; then
  echo "PASS: Tier 1 and Tier 2 signatures differ (proves buyer_pubkey is in the digest)"
else
  echo "FAIL: same signature for Tier 1 and Tier 2 — buyer_pubkey not bound"
  exit 1
fi
echo ""

echo "=== Test 10: tampered det_hash rejected ==="
TAMPERED=$(echo $RECEIPT_FULL | jq '.det_hash="0x0000000000000000000000000000000000000000000000000000000000000000"')
TAMPER_RESP=$(curl -s -X POST $VERIFIER/attest \
  -H "Content-Type: application/json" \
  -d "{\"receipt\":$TAMPERED,\"tier\":1}")
TAMPER_VALID=$(echo "$TAMPER_RESP" | jq -r .valid)
if [ "$TAMPER_VALID" = "false" ]; then
  echo "PASS: tampered det_hash rejected"
else
  echo "FAIL: tampered det_hash accepted"
  echo "$TAMPER_RESP" | jq .
  exit 1
fi
echo ""

echo "=== Test 11: Tier 2 without buyer_pubkey rejected ==="
NOPUB_RESP=$(curl -s -X POST $VERIFIER/attest \
  -H "Content-Type: application/json" \
  -d "{\"receipt\":$RECEIPT_FULL,\"tier\":2}")
NOPUB_VALID=$(echo "$NOPUB_RESP" | jq -r .valid)
if [ "$NOPUB_VALID" = "false" ]; then
  echo "PASS: Tier 2 without buyer_pubkey rejected"
else
  echo "FAIL: Tier 2 without buyer_pubkey accepted"
  exit 1
fi
echo ""

echo "=== Test 12: wrong proof_format rejected ==="
WRONGFMT=$(echo $RECEIPT_FULL | jq '.proof_format="pd19-v1"')
WRONGFMT_RESP=$(curl -s -X POST $VERIFIER/attest \
  -H "Content-Type: application/json" \
  -d "{\"receipt\":$WRONGFMT,\"tier\":1}")
WRONGFMT_VALID=$(echo "$WRONGFMT_RESP" | jq -r .valid)
if [ "$WRONGFMT_VALID" = "false" ]; then
  echo "PASS: pd19-v1 receipt rejected by stub-v1 verifier"
else
  echo "FAIL: stub-v1 verifier accepted pd19-v1 receipt"
  exit 1
fi
echo ""

echo "================================="
echo "ALL ACCEPTANCE TESTS PASSED (12/12)"
echo "================================="
echo ""
echo "Verifier address (register on VerifierRegistry): $VERIFIER_ADDR"
echo "Tier 1 signature: $TIER1_SIG"
echo "Tier 2 signature: $TIER2_SIG"
echo ""
echo "Both signatures recover to the verifier address using the SAME EIP-712"
echo "domain that Escrow.sol will use. The on-chain settleTier1/settleTier2 calls"
echo "will succeed when given these signatures."
