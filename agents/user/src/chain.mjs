/**
 * ChainClient — viem-based wrapper for Escrow contract calls on 0G Galileo.
 *
 * Why viem and not cast:
 *   cast send polls eth_getTransactionReceipt synchronously and exits 1 if
 *   the receipt is null. 0G Galileo's RPC sometimes returns null receipts
 *   for ~5-30 seconds even when the tx is actually mined. With cast, this
 *   produces silent successes and amplifies on retry (see Day 3 morning).
 *
 *   viem's waitForTransactionReceipt() treats null receipts as "not yet,
 *   keep polling" instead of as a fatal error. Times out cleanly at 60s.
 *   Same model the web UI on Day 5 will use — single library across stack.
 */

import { createWalletClient, createPublicClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// 0G Galileo testnet
const galileo = defineChain({
  id: 16602,
  name: '0G Galileo',
  network: '0g-galileo',
  nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
  rpcUrls: {
    default: { http: ['https://evmrpc-testnet.0g.ai'] },
    public:  { http: ['https://evmrpc-testnet.0g.ai'] },
  },
  blockExplorers: {
    default: { name: 'ChainScan', url: 'https://chainscan-galileo.0g.ai' },
  },
});

// Escrow ABI subset — only the functions we call from the runtime.
// Order matches src/Escrow.sol so any drift surfaces immediately.
const ESCROW_ABI = [
  {
    type: 'function',
    name: 'openTrade',
    stateMutability: 'payable',
    inputs: [
      { name: 'trade_id',          type: 'bytes32' },
      { name: 'seller',            type: 'address' },
      { name: 'tier1_amount',      type: 'uint256' },
      { name: 'tier2_amount',      type: 'uint256' },
      { name: 'psec_version',      type: 'bytes32' },
      { name: 'model_commitment',  type: 'bytes32' },
      { name: 'input_hash',        type: 'bytes32' },
      { name: 'output_hash',       type: 'bytes32' },
      { name: 'proof_format',      type: 'string'  },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'settleTier1',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'trade_id', type: 'bytes32' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'settleTier2',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'trade_id',     type: 'bytes32' },
      { name: 'buyer_pubkey', type: 'bytes' },
      { name: 'signature',    type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'isSettled',
    stateMutability: 'view',
    inputs: [{ name: 'trade_id', type: 'bytes32' }],
    outputs: [
      { name: 'tier1', type: 'bool' },
      { name: 'tier2', type: 'bool' },
    ],
  },
];

export class ChainClient {
  constructor({ escrowAddr, rpcUrl, privateKey, txTimeoutMs = 60_000 }) {
    if (!escrowAddr) throw new Error('escrowAddr required');
    if (!rpcUrl)     throw new Error('rpcUrl required');
    if (!privateKey) throw new Error('privateKey required');

    // Normalize escrowAddr to a string starting with 0x
    this.escrowAddr = escrowAddr.startsWith('0x') ? escrowAddr : '0x' + escrowAddr;
    this.txTimeoutMs = txTimeoutMs;

    // Allow overriding rpcUrl per instance (tests may use a different RPC)
    const chainOverride = rpcUrl ? { ...galileo, rpcUrls: { default: { http: [rpcUrl] }, public: { http: [rpcUrl] } } } : galileo;

    const account = privateKeyToAccount(privateKey.startsWith('0x') ? privateKey : '0x' + privateKey);
    const transport = http(rpcUrl);

    this.walletClient = createWalletClient({ account, transport, chain: chainOverride });
    this.publicClient = createPublicClient({ transport, chain: chainOverride });
    this.account = account;
  }

  async openTrade({
    tradeId, seller, tier1Wei, tier2Wei,
    psecVersion, modelCommitment, inputHash, outputHash,
    proofFormat, valueWei,
  }) {
    const hash = await this.walletClient.writeContract({
      address: this.escrowAddr,
      abi: ESCROW_ABI,
      functionName: 'openTrade',
      args: [
        tradeId, seller, BigInt(tier1Wei), BigInt(tier2Wei),
        psecVersion, modelCommitment, inputHash, outputHash,
        proofFormat,
      ],
      value: BigInt(valueWei),
    });
    await this._waitForReceipt(hash, 'openTrade');
    return hash;
  }

  async settleTier1({ tradeId, signature }) {
    const hash = await this.walletClient.writeContract({
      address: this.escrowAddr,
      abi: ESCROW_ABI,
      functionName: 'settleTier1',
      args: [tradeId, signature],
    });
    await this._waitForReceipt(hash, 'settleTier1');
    return hash;
  }

  async settleTier2({ tradeId, buyerPubkey, signature }) {
    const hash = await this.walletClient.writeContract({
      address: this.escrowAddr,
      abi: ESCROW_ABI,
      functionName: 'settleTier2',
      args: [tradeId, buyerPubkey, signature],
    });
    await this._waitForReceipt(hash, 'settleTier2');
    return hash;
  }

  async isSettled(tradeId) {
    const result = await this.publicClient.readContract({
      address: this.escrowAddr,
      abi: ESCROW_ABI,
      functionName: 'isSettled',
      args: [tradeId],
    });
    // viem returns the named tuple as an array
    return { tier1: !!result[0], tier2: !!result[1] };
  }

  async _waitForReceipt(hash, label) {
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash,
      timeout: this.txTimeoutMs,
      // Poll every 1s — Galileo's null-response window is 5-30s typically
      pollingInterval: 1000,
    });
    if (receipt.status !== 'success') {
      throw new Error(`${label} reverted: tx=${hash} block=${receipt.blockNumber}`);
    }
    return receipt;
  }
}
