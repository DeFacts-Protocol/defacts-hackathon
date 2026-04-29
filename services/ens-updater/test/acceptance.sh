#!/bin/bash
# ENS updater acceptance test.
#
# Validates the EnsUpdater class works against Sepolia.
# Reads/writes a single test record, no subname creation by default.
#
# Required env: ENS_OWNER_PRIVKEY (loaded into shell, NOT from .env)

set -euo pipefail

cd "$(dirname "$0")/.."
SVC_DIR="$(pwd)"
echo "Service dir: $SVC_DIR"

if [ -z "${ENS_OWNER_PRIVKEY:-}" ]; then
  echo "FAIL: ENS_OWNER_PRIVKEY not set in shell"
  echo "  export ENS_OWNER_PRIVKEY=0x...  # before running"
  exit 1
fi

testNum=0
pass() { testNum=$((testNum+1)); echo "✓ Test $testNum: $1"; }
fail() { testNum=$((testNum+1)); echo "✗ Test $testNum: $1"; [ -n "${2:-}" ] && echo "    $2"; exit 1; }

# ─── Test 1: CLI loads and shows help ───────────────────────────────────

if node src/cli.mjs --help 2>&1 | grep -q "Usage:"; then
  pass "CLI shows help"
else
  fail "CLI help missing"
fi

# ─── Test 2: read existing record (parent name) ─────────────────────────

VAL=$(node src/cli.mjs read defacts.eth defacts.test 2>&1 || true)
if echo "$VAL" | grep -q "defacts.test"; then
  pass "read defacts.eth/defacts.test (returned: $(echo "$VAL" | tail -1))"
else
  fail "read returned unexpected output" "$VAL"
fi

# ─── Test 3: write a fresh test record + read it back ───────────────────

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TESTKEY="defacts.acceptance-test"
TESTVAL="acceptance-$TS"

echo ""
echo "═══ Writing test record ═══"
node src/cli.mjs set defacts.eth "$TESTKEY" "$TESTVAL"

echo ""
echo "═══ Waiting 3s for confirmation ═══"
sleep 3

echo ""
echo "═══ Reading back ═══"
READBACK=$(node src/cli.mjs read defacts.eth "$TESTKEY" 2>&1 | tail -1)

if echo "$READBACK" | grep -q "$TESTVAL"; then
  pass "wrote + read back: $TESTVAL"
else
  fail "round-trip failed" "expected: $TESTVAL  got: $READBACK"
fi

# ─── Test 4: dump command ───────────────────────────────────────────────

DUMP=$(node src/cli.mjs dump defacts.eth 2>&1)
if echo "$DUMP" | grep -q "$TESTKEY"; then
  pass "dump shows the test record"
else
  fail "dump missing test record" "$DUMP"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ✓ ENS updater acceptance: $testNum/$testNum tests passed"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "  defacts.eth on Sepolia is writable from this shell."
echo "  Test record:  $TESTKEY = $TESTVAL"
echo ""
echo "  Next: run 'node src/cli.mjs setup' to register"
echo "  l4/l40s/h100 subnames + initial records."
