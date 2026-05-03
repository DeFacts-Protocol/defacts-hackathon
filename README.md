# DeFacts

**A peer-to-peer marketplace for verifiable AI inference.**
*Built for ETHGlobal Open Agents 2026.*

> Buyers post queries. Suppliers bid with deterministic receipts.
> The cheapest verified bid wins, the trade settles on-chain, and
> the winning supplier's reputation accrues in ENS records.
>
> One command runs the full marketplace round-trip end-to-end:
>
> ```bash
> bash script/test-ens-integration.sh
> ```
>
> 15 acceptance tests, real Galileo settlement, real Sepolia ENS records.

---

## Three layers, three chains, one receipt

| Layer | Tech | What it does |
|---|---|---|
| **Discovery** | Gensyn AXL | Suppliers and buyers find each other over a gossip mesh. Bids carry signed Tier1 attestations over the receipt's hashes. |
| **Settlement** | 0G Galileo (chain 16602) | An Escrow contract releases funds only when on-chain signature recovery matches the bound verifier. Two-tier model: Tier 1 for access, Tier 2 cryptographically bound to the buyer (non-resale). |
| **Reputation** | ENS on Sepolia | After settlement, the winning supplier's subname (`l4.defacts.eth`) gets `last_trade_id`, `last_settlement_tx`, `last_attestation`, `last_tier_settled` written. A queryable on-chain track record. |

The receipts settled and recorded are EIP-712 typed structs (`psec_version`, `model_commitment`, `input_hash`, `output_hash`, `tier`) — not placeholders, not opaque blobs.

## Our contribution: PSEC

**PSEC (Portable Semantic Execution Contract)** is the specification that makes those receipts comparable across heterogeneous hardware. Same inputs, same output hash, regardless of which GPU ran the inference. That's what lets a buyer route to the cheapest supplier without sacrificing what they're paying for, and it's what makes a price-discovered inference market economically real instead of theoretical.

PSEC is published, MIT-licensed, prover-agnostic. Any prover that produces the canonical PSEC output for a given input can join the marketplace.

## What's deployed

**0G Galileo (chain id 16602):**
- Escrow: [`0xF49490aCd9c3Fb548c57BafF7034cD686827a641`](https://chainscan-galileo.0g.ai/address/0xF49490aCd9c3Fb548c57BafF7034cD686827a641)
- VerifierRegistry: [`0xD02b5855E0c0F50DB9555417cC269c2F19fbA0B2`](https://chainscan-galileo.0g.ai/address/0xD02b5855E0c0F50DB9555417cC269c2F19fbA0B2)

**ENS on Sepolia:**
- Parent: [`defacts.eth`](https://app.ens.domains/defacts.eth)
- Supplier subnames live, updated per trade

**Registered verifiers:**
- `stub-v1` — deterministic test prover (canonical hash synthesis, in-repo)
- `pd19-v1` (`0x7177...3deb`) — one production PSEC implementation, called over HTTP. PD19 is proprietary infrastructure maintained separately; this repo contains only the adapter that calls it.

## Quick start

**Prereqs:** Node 18+, Foundry, accounts funded on 0G Galileo and Sepolia.

```bash
git clone https://github.com/DeFacts-Protocol/defacts-hackathon.git
cd defacts-hackathon
cp .env.example .env
# Edit .env with your keys and RPC URLs

# Baseline (local stubs only)
bash script/end-of-day-3.sh

# Full end-to-end (Galileo settle + Sepolia ENS update)
ENABLE_ENS=1 bash script/test-ens-integration.sh
```

To swap the stub prover for a live PSEC implementation:

```bash
PD19_INFER_URL=https://your-pd19-host/infer \
  node services/pd19-adapter/src/server.mjs &

PROVER_ENDPOINT=http://localhost:7011 \
  bash agents/fresh/test/acceptance.sh
```

## What's in this repo

- `src/Escrow.sol`, `src/VerifierRegistry.sol` — settlement contracts
- `agents/user/`, `agents/cache/`, `agents/fresh/` — buyer + two supplier runtimes over AXL
- `services/ens-updater/` — Sepolia ENS record writer
- `services/pd19-adapter/` — HTTP adapter from PSEC schema to PD19
- `services/verifier-stub/`, `services/prover-stub/` — local test infrastructure
- `script/test-ens-integration.sh` — full marketplace + settlement + reputation acceptance
- `gate4-axl/` — AXL transport integration

## Hackathon prize tracks

- **Gensyn AXL** — DeFacts uses AXL gossip as the discovery and bidding layer for the marketplace.
- **0G** — Settlement happens on Galileo; the receipt + Escrow contract together form a settlement primitive for verifiable inference.
- **ENS-AI** — ENS subnames are the supplier identity layer for the marketplace.
- **ENS-Creative** — On-chain reputation accrual through per-trade ENS record updates.

## Scope

Built from scratch for ETHGlobal Open Agents 2026, April 27 – May 3, 2026.

## License

MIT.

The PSEC specification, the marketplace protocol, the agent runtimes, the settlement contracts, the ENS integration, and the PD19 HTTP adapter are all MIT-licensed and open. The PD19 implementation itself (called over HTTP by the adapter) is proprietary infrastructure maintained separately by Paradatum Inc; this repository does not contain PD19 source code.

Anyone is free to implement PSEC and join the marketplace as a supplier — that's the entire point of the standard.
