#!/bin/bash
# ENS integration acceptance.
#
# Validates that a full marketplace round-trip — settled on Galileo —
# triggers ENS record updates on Sepolia.
#
# Reuses end-of-day-3.sh for the marketplace setup (3 AXL nodes, 2 suppliers,
# user-runtime as buyer). Adds ENS_OWNER_PRIVKEY + ENABLE_ENS=1 to the
# environment so the driver instantiates an EnsUpdater and the user-runtime
# fires post-settle ENS updates.
#
# After settlement, the driver polls Sepolia for the ENS records to update
# (up to 90s; 8 sequential setText txs at ~12s each = ~96s worst case;
# typical is ~30-60s).
#
# Required env (must be in shell, NOT in .env):
#   ENS_OWNER_PRIVKEY=0x...    privkey of defacts.eth owner on Sepolia
#                              (different wallet from the Galileo trading wallet)
#
# Optional env:
#   SEPOLIA_RPC_URL            defaults to https://ethereum-sepolia-rpc.publicnode.com
#
# Notes:
#   - ENS owner privkey is read from shell env, NOT from .env. This is
#     deliberate — funded burner wallets shouldn't sit in files that
#     other tools source.
#   - Test count: end-of-day-3 baseline (10) + ENS verification (5) = 15.

set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$(pwd)"

if [ -z "${ENS_OWNER_PRIVKEY:-}" ]; then
  echo "FAIL: ENS_OWNER_PRIVKEY not set in shell"
  echo ""
  echo "  Re-derive it from your seed phrase:"
  echo ""
  echo "    read -s -p 'Paste 12 words: ' SEED"
  echo "    export ENS_OWNER_PRIVKEY=\$(cast wallet private-key --mnemonic \"\$SEED\" --mnemonic-index 0)"
  echo "    unset SEED"
  echo ""
  exit 1
fi

# Verify the privkey resolves to the expected address (sanity check)
if ! command -v cast >/dev/null; then
  echo "WARN: cast not in PATH, skipping privkey verification"
else
  EXPECTED="0xEfcD46557D14B654DF35d77be9fd96B04B520f0B"
  ACTUAL=$(cast wallet address --private-key "$ENS_OWNER_PRIVKEY" 2>/dev/null || echo "")
  if [ "${ACTUAL,,}" != "${EXPECTED,,}" ]; then
    echo "FAIL: ENS_OWNER_PRIVKEY does not derive to expected address"
    echo "  expected: $EXPECTED"
    echo "  got:      $ACTUAL"
    exit 1
  fi
fi

echo "═══════════════════════════════════════════════════════════"
echo "  ENS INTEGRATION ACCEPTANCE"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  Trade settles on Galileo (16602)."
echo "  ENS records update on Sepolia for the winning supplier's subname."
echo ""
echo "  This will perform up to ~8 Sepolia setText txs (~$0.001 of testnet ETH)."
echo ""

# Forward ENS env vars to end-of-day-3.sh so the driver picks them up
export ENABLE_ENS=1
export ENS_OWNER_PRIVKEY
export SEPOLIA_RPC_URL="${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"

# Run the existing end-of-day-3 acceptance, which now picks up our env vars
# (after the small forwarding edit to that script)
exec bash "$REPO/script/end-of-day-3.sh"
