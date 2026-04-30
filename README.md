# DeFacts

**An open marketplace for verifiable AI inference, with cross-chain settlement and reputation.**

ETHGlobal Open Agents 2026 hackathon submission.

---

## What this is

DeFacts is a working two-chain marketplace where AI suppliers compete to provide cryptographically verifiable inference. Buyers issue queries; multiple suppliers independently produce answers; cross-supplier hash agreement provides trust; settlement happens on a public blockchain; supplier reputation accumulates as ENS records.

The protocol is governed by **PSEC** (Portable Semantic Execution Contract) — a published math contract specifying exactly what counts as correct inference: which model, which precision, which decoding strategy, which accumulation rules. Any prover that can produce the canonical PSEC output for a given input can participate in the marketplace. Buyers compete suppliers on price; PSEC holds the math constant.

## What's included

- **Settlement contracts** — Escrow + VerifierRegistry deployed on 0G Galileo testnet (chain id 16602). Two-tier settlement model: Tier 1 for information access, Tier 2 cryptographically bound to the buyer to prevent receipt resale.
- **Agent runtimes** — User-runtime (buyer), cache-mode-agent (cache-served), fresh-mode-agent (live prover), all coordinating over Gensyn AXL transport.
- **Cross-supplier consensus** — Buyer's runtime filters bids to the modal-hash group before picking a winner, providing trust through agreement.
- **Cross-chain reputation** — On settlement, the winning supplier's ENS subname on Sepolia (e.g. `l4.defacts.eth`) updates with the trade evidence: `last_trade_id`, `last_settlement_tx`, `last_attestation`, `last_active_at`. Anyone resolving the ENS name can navigate from identity to settlement evidence on a different chain.
- **PD19 adapter** — Translates between the marketplace's PSEC receipt schema and PD19, one production implementation of PSEC running on RunPod GPUs.
- **Carol-fails CLI** — Demonstrates Tier 2 cryptographic non-resale: a receipt bound to Alice's pubkey fails verification when forwarded to Carol.

## Project scope

This repository was built from scratch starting **April 27, 2026** for the ETHGlobal Open Agents 2026 hackathon. The code in this repository is the hackathon project: marketplace protocol, agent runtimes, settlement contracts, ENS integration, PSEC specification, and adapters.

PD19, used here as one production implementation of PSEC, is preexisting external infrastructure developed by Paradatum Inc. PD19 itself is not part of this hackathon submission; the submission is the open marketplace and standard that PD19 (and any other PSEC-compliant prover) can plug into.

## Architecture

```
   Buyer's user-runtime ─┬──── query (AXL gossip) ───→ Supplier agents
                         │                                    │
                         │      bids (det_hash + price)      │
                         │←───────────────────────────────────┘
                         │
                         ▼
              Consensus filter: modal-hash group
                         │
                         ▼
                  Lowest-price winner
                         │
                         ▼
            ┌─ openTrade ──→ Galileo Escrow ─┐
            │                                │
            │     settleTier1 + signature    │
            │                                │
            └─ event: Tier1Settled ──────────┘
                         │
                         ▼
            Best-effort ENS update on Sepolia
              (winner's subname text records)
```

## Quick start

Prerequisites: Node 18+, Foundry, accounts funded on 0G Galileo and Sepolia.

```bash
# Clone
git clone https://github.com/DeFacts-Protocol/defacts-hackathon.git
cd defacts-hackathon

# Configure environment
cp .env.example .env
# Edit .env with your keys and RPC URLs

# Run baseline acceptance suite (uses local stubs)
bash script/end-of-day-3.sh

# Run ENS-integrated end-to-end test (Galileo settle + Sepolia ENS update)
ENABLE_ENS=1 bash script/test-ens-integration.sh
```

To run with live PD19 inference instead of the local stub, point the adapter at your PD19 endpoint:

```bash
PD19_INFER_URL=https://your-pd19-host/infer \
  node services/pd19-adapter/src/server.mjs &

PROVER_ENDPOINT=http://localhost:7011 \
  bash agents/fresh/test/acceptance.sh
```

## Smart contracts

Deployed on 0G Galileo (chain id 16602):

- **VerifierRegistry**: `0xD02b5855E0c0F50DB9555417cC269c2F19fbA0B2`
- **Escrow**: `0xF49490aCd9c3Fb548c57BafF7034cD686827a641`

Verifier services registered on-chain:

- **stub-v1**: deterministic test prover (synthesizes a canonical hash)
- **pd19-v1** (`0x7177Cc3b7EF932DfA08F81f799A9038d47f13deb`): production PSEC implementation via PD19

## Hackathon prize tracks

- Gensyn AXL — Best Application
- 0G — Best Agent Framework
- ENS — Best Integration for AI Agents
- ENS — Most Creative Use

## License

MIT.

The PSEC specification, the marketplace protocol, the agent runtimes, the settlement contracts, the ENS integration, and the PD19 HTTP adapter are all MIT-licensed and open. The PD19 implementation itself (called over HTTP by the adapter) is proprietary infrastructure maintained separately by Paradatum Inc; this repository does not contain PD19 source code.

Anyone is free to implement PSEC themselves and join the marketplace as a supplier — that is the entire point of the standard.
