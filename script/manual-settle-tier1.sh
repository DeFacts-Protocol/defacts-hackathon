#!/bin/bash
# End-of-Day-2 manual settlement walkthrough.
#
# Confirms the protocol's spine works end-to-end against a real Galileo
# deployment plus locally-running stubs. This is THE acceptance gate for
# Day 2 — when this script's last `cast call` shows Tier1Settled, you're done.
#
# Prerequisites (in this order):
#   1. prover-stub running on :7001       (services/prover-stub/)
#   2. verifier-stub running on :7002     (services/verifier-stub/)
#         IMPORTANT: must be started with ESCROW_ADDR=$ESCROW_ADDR to match
#                    the deployed Escrow's DOMAIN_SEPARATOR
#   3. .env has VERIFIER_REGISTRY_ADDR + ESCROW_ADDR set to deployed addresses
#   4. WALLET_PRIVKEY funded on Galileo
#
# Usage:
#   bash scripts/manual-settle-tier1.sh

set -euo pipefail

# ─── Load .env ───────────────────────────────────────────────────────────
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then echo "ERROR: .env not found"; exit 1; fi
set -a; source .env; set +a

# Map .env names -> what cast/forge expect
RPC="${ZERO_G_RPC_URL:-${GALILEO_RPC:-}}"
KEY="${WALLET_PRIVKEY:-${DEPLOYER_PRIVATE_KEY:-}}"
EXPLORER="${ZERO_G_EXPLORER:-https://chainscan-galileo.0g.ai}"

if [ -z "$RPC" ];                        then echo "ERROR: ZERO_G_RPC_URL or GALILEO_RPC required"; exit 1; fi
if [ -z "$KEY" ];                        then echo "ERROR: WALLET_PRIVKEY required";              exit 1; fi
if [ -z "${VERIFIER_REGISTRY_ADDR:-}" ]; then echo "ERROR: VERIFIER_REGISTRY_ADDR required";      exit 1; fi
if [ -z "${ESCROW_ADDR:-}" ];            then echo "ERROR: ESCROW_ADDR required";                 exit 1; fi

BUYER_ADDR=$(cast wallet address $KEY)
SELLER_ADDR="${SELLER_ADDR:-$BUYER_ADDR}"  # default: settle to self for simplicity

echo "=========================================="
echo "End-of-Day-2 manual settlement walkthrough"
echo "=========================================="
echo "RPC:            $RPC"
echo "Explorer:       $EXPLORER"
echo "Buyer (KEY):    $BUYER_ADDR"
echo "Seller:         $SELLER_ADDR"
echo "Registry:       $VERIFIER_REGISTRY_ADDR"
echo "Escrow:         $ESCROW_ADDR"
echo ""

# ─── Step 1: confirm services are up ─────────────────────────────────────

echo "─── Step 1: checking services ───"
PROVER_HEALTH=$(curl -sf http://localhost:7001/health || echo "DOWN")
VERIFIER_HEALTH=$(curl -sf http://localhost:7002/health || echo "DOWN")
if [ "$PROVER_HEALTH" = "DOWN" ];   then echo "ERROR: prover-stub :7001 down";   exit 1; fi
if [ "$VERIFIER_HEALTH" = "DOWN" ]; then echo "ERROR: verifier-stub :7002 down"; exit 1; fi
echo "prover:    $(echo $PROVER_HEALTH | jq -c .)"
echo "verifier:  $(echo $VERIFIER_HEALTH | jq -c .)"

# CRITICAL: verifier's escrow_addr must match our ESCROW_ADDR
VERIFIER_ESCROW=$(echo $VERIFIER_HEALTH | jq -r .escrow_addr)
if [ "${VERIFIER_ESCROW,,}" != "${ESCROW_ADDR,,}" ]; then
  echo ""
  echo "ERROR: verifier-stub configured with ESCROW_ADDR=$VERIFIER_ESCROW"
  echo "       but .env has ESCROW_ADDR=$ESCROW_ADDR"
  echo ""
  echo "Restart verifier-stub with the correct address:"
  echo "  cd services/verifier-stub"
  echo "  ESCROW_ADDR=$ESCROW_ADDR node server.mjs"
  exit 1
fi
echo "PASS: verifier-stub configured for the right Escrow"

VERIFIER_ADDR=$(echo $VERIFIER_HEALTH | jq -r .verifier_address)
echo "verifier_address: $VERIFIER_ADDR"
echo ""

# ─── Step 2: get a receipt from prover-stub ──────────────────────────────

echo "─── Step 2: get receipt from prover-stub (canonical France) ───"
PSEC_VERSION="0x$(printf '11%.0s' {1..32})"
MODEL_COMMITMENT="0x$(printf '22%.0s' {1..32})"

RECEIPT=$(curl -s -X POST http://localhost:7001/prove \
  -H "Content-Type: application/json" \
  -d "{
    \"psec_version\":\"$PSEC_VERSION\",
    \"model_commitment\":\"$MODEL_COMMITMENT\",
    \"input_token_ids\":[785,6722,315,9625,374],
    \"max_output_tokens\":20,
    \"decoding\":\"greedy\"
  }")
DET_HASH=$(echo $RECEIPT | jq -r .det_hash)
OUTPUT_IDS=$(echo $RECEIPT | jq -c .output_token_ids)
echo "det_hash:     $DET_HASH"
echo "output_ids:   $OUTPUT_IDS"
echo ""

# Build full receipt JSON for verifier-stub
RECEIPT_FULL=$(jq -n \
  --argjson outputs "$OUTPUT_IDS" \
  --arg dethash "$DET_HASH" \
  --arg psec "$PSEC_VERSION" \
  --arg model "$MODEL_COMMITMENT" \
  '{
    psec_version: $psec, model_commitment: $model,
    input_token_ids: [785,6722,315,9625,374],
    output_token_ids: $outputs,
    det_hash: $dethash, proof_format: "stub-v1", proof_blob: $dethash
  }')

# ─── Step 3: get Tier 1 attestation from verifier-stub ───────────────────

echo "─── Step 3: get Tier 1 attestation from verifier-stub ───"
ATTEST=$(curl -s -X POST http://localhost:7002/attest \
  -H "Content-Type: application/json" \
  -d "{\"receipt\":$RECEIPT_FULL,\"tier\":1}")
SIGNATURE=$(echo $ATTEST | jq -r .signature)
INPUT_HASH=$(echo $ATTEST | jq -r .input_hash)
OUTPUT_HASH=$(echo $ATTEST | jq -r .output_hash)
echo "signature:    $SIGNATURE"
echo "input_hash:   $INPUT_HASH"
echo "output_hash:  $OUTPUT_HASH"

if [ "$INPUT_HASH" != "0x05c0be0a90d620aaa058e271a2d96610aa364b818ddd48dd7db44a62b398ae4f" ]; then
  echo "ERROR: input_hash mismatch — receipt format spec divergence?"
  exit 1
fi
echo ""

# ─── Step 4: openTrade on chain ─────────────────────────────────────────

echo "─── Step 4: openTrade on Galileo ───"
TRADE_ID="0x$(openssl rand -hex 32)"
TIER1_AMOUNT_WEI="100000000000000"      # 0.0001 0G
TIER2_AMOUNT_WEI="500000000000000"      # 0.0005 0G
TOTAL_WEI="600000000000000"
echo "trade_id:     $TRADE_ID"
echo "tier1_amount: $TIER1_AMOUNT_WEI wei (0.0001 0G)"
echo "tier2_amount: $TIER2_AMOUNT_WEI wei (0.0005 0G)"
echo ""

OPEN_TX=$(cast send $ESCROW_ADDR \
  "openTrade(bytes32,address,uint256,uint256,bytes32,bytes32,bytes32,bytes32,string)" \
  $TRADE_ID $SELLER_ADDR $TIER1_AMOUNT_WEI $TIER2_AMOUNT_WEI \
  $PSEC_VERSION $MODEL_COMMITMENT $INPUT_HASH $OUTPUT_HASH "stub-v1" \
  --value $TOTAL_WEI \
  --rpc-url $RPC \
  --private-key $KEY \
  --legacy --json | jq -r .transactionHash)

echo "openTrade tx: $OPEN_TX"
echo "explorer:     $EXPLORER/tx/$OPEN_TX"
echo ""

# ─── Step 5: settleTier1 ─────────────────────────────────────────────────

echo "─── Step 5: settleTier1 ───"
SETTLE_TX=$(cast send $ESCROW_ADDR \
  "settleTier1(bytes32,bytes)" \
  $TRADE_ID $SIGNATURE \
  --rpc-url $RPC \
  --private-key $KEY \
  --legacy --json | jq -r .transactionHash)

echo "settleTier1 tx: $SETTLE_TX"
echo "explorer:       $EXPLORER/tx/$SETTLE_TX"
echo ""

# ─── Step 6: confirm settled flag on-chain ───────────────────────────────

echo "─── Step 6: confirm Tier1 settled on-chain ───"
SETTLED=$(cast call $ESCROW_ADDR \
  "isSettled(bytes32)" $TRADE_ID \
  --rpc-url $RPC)
# isSettled returns (bool, bool). cast prints them as 32-byte hex words.
T1_HEX=$(echo $SETTLED | cut -c1-66)
T2_HEX=$(echo $SETTLED | cut -c67-)
T2_HEX="0x$T2_HEX"

if [ "$T1_HEX" = "0x0000000000000000000000000000000000000000000000000000000000000001" ]; then
  echo "PASS: Tier 1 settled flag is true on-chain"
else
  echo "FAIL: settled flag = $T1_HEX (expected 0x...001)"
  exit 1
fi

echo ""
echo "=========================================="
echo "✓ END-OF-DAY-2 ACCEPTANCE PASSED"
echo "=========================================="
echo "Trade ID:     $TRADE_ID"
echo "openTrade:    $EXPLORER/tx/$OPEN_TX"
echo "settleTier1:  $EXPLORER/tx/$SETTLE_TX"
echo ""
echo "The protocol's spine works end-to-end:"
echo "  prover-stub → receipt"
echo "  verifier-stub → EIP-712 signed attestation"
echo "  Escrow (on Galileo) → recovers signer, validates against registry,"
echo "                        releases tier1_amount to seller"
echo ""
echo "Day 2 complete. Day 3 (AXL transport) starts from here."
