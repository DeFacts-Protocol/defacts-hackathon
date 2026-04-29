# Gate Log

## Gate 1: 0G Chain dry-run — GREEN (Apr 27)
- Network: 0G Galileo testnet (chain id 16602)
- RPC: https://evmrpc-testnet.0g.ai
- HelloWorld deployed: 0xF8201dbcF37FaA4FB7311C2247807F39A35B47e3
- Deploy tx:  0x9c6c73a3d16c9fa8e7b5ec5800c1b710ce173dbf4bd5bac71f22bfd60e15d7b9
- setMessage: 0x101b448283f116058e99343626110bfaf0846dc422a4959b6c6f9d2d75c1f999
- getMessage returned: "hello defacts"
- Gas: 44,787 @ 4 gwei

## Gate 2: 0G Storage SDK — GREEN (Apr 27)
- SDK: @0gfoundation/0g-ts-sdk
- Indexer: https://indexer-storage-testnet-turbo.0g.ai
- Test payload: 995 bytes JSON
- Root hash: 0x14db29a10780eccf63c711ebdea8c1e18f3dc709eafc3dbe8d533767246eb32a
- Storage tx:  0x301e2f064123133e66c5c9c53804948c5112be6b3894ec5537489a172ef3bc9a
- SHA-256: c3fc11c8182e69934602cd3995440dd05c1a278e71db55921a503de8f479ed45
- Replicated to 4 storage nodes
- 30+ min persistence: byte-identical re-fetch confirmed

## Gate 3: ENS — GREEN (Apr 27)
- Name: defacts.eth on Sepolia
- Owner: 0xEfcD46557D14B654DF35d77be9fd96B04B520f0B (personal wallet)
- Expiry: April 27, 2027
- Decision: Option A (keep on personal wallet, sign subname txs from there)

## Gate 4: AXL — IN PROGRESS (Apr 27)
- Repo: github.com/gensyn-ai/axl (cloned)
- Language: Go (toolchain 1.25.5 pinned)
- Architecture confirmed: localhost HTTP bridge on :9002, peers via tls://
- Browser→AXL: NO direct path (binary only). Day 5 needs Node relay → AXL bridge.
