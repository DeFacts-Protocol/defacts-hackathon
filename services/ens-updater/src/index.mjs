/**
 * ENS updater — writes text records and creates subnames on Sepolia.
 *
 * Why ENS records on Sepolia: the marketplace's agents and the parent
 * 'defacts.eth' name need on-chain identity records that are independent
 * of the trading chain (Galileo). Sepolia + ENS is the standard place for
 * this. Settlement happens on Galileo; identity + reputation surface on
 * Sepolia ENS.
 *
 * Design:
 *   - Best-effort. Failures here never block a Galileo settlement.
 *   - Every write logged with the tx hash for auditability.
 *   - Subnames created lazily on first use (idempotent).
 *
 * The wallet that owns 'defacts.eth' on Sepolia (separate from the Galileo
 * trading wallet) signs all ENS txs. Privkey is read from ENS_OWNER_PRIVKEY
 * env var — we deliberately don't read this from .env to avoid putting a
 * funded burner-wallet key in a file other tools source.
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  namehash,
  keccak256,
  toBytes,
} from 'viem';
import { sepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

// ─── Sepolia ENS deployment addresses ────────────────────────────────────

export const SEPOLIA_ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
export const SEPOLIA_PUBLIC_RESOLVER = '0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5';
export const DEFAULT_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';

// ─── ABI fragments ───────────────────────────────────────────────────────

const REGISTRY_ABI = [
  {
    type: 'function', name: 'owner', stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function', name: 'resolver', stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'function', name: 'setSubnodeRecord', stateMutability: 'nonpayable',
    inputs: [
      { name: 'node',     type: 'bytes32' },
      { name: 'label',    type: 'bytes32' },
      { name: 'owner',    type: 'address' },
      { name: 'resolver', type: 'address' },
      { name: 'ttl',      type: 'uint64'  },
    ],
    outputs: [],
  },
];

const RESOLVER_ABI = [
  {
    type: 'function', name: 'text', stateMutability: 'view',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'key',  type: 'string'  },
    ],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function', name: 'setText', stateMutability: 'nonpayable',
    inputs: [
      { name: 'node',  type: 'bytes32' },
      { name: 'key',   type: 'string'  },
      { name: 'value', type: 'string'  },
    ],
    outputs: [],
  },
];

// ─── Utility: compute label hash and child namehash ──────────────────────

function labelhash(label) {
  return keccak256(toBytes(label));
}

function childNamehash(parentNode, label) {
  // namehash(child) = keccak256(parentNode || labelhash(label))
  // We just call viem's namehash on the full string, but accept the parent
  // form too for cases where we need to compute without already having the name.
  const labelHashHex = labelhash(label);
  // concat parent (32 bytes) + labelhash (32 bytes) and hash
  return keccak256(`0x${parentNode.slice(2)}${labelHashHex.slice(2)}`);
}

// ─── EnsUpdater class ────────────────────────────────────────────────────

export class EnsUpdater {
  constructor({
    rpcUrl = DEFAULT_RPC,
    privateKey,
    parentName = 'defacts.eth',
    registry = SEPOLIA_ENS_REGISTRY,
    resolver = SEPOLIA_PUBLIC_RESOLVER,
    quiet = false,
  } = {}) {
    if (!privateKey) throw new Error('EnsUpdater: privateKey required');
    const pk = privateKey.startsWith('0x') ? privateKey : '0x' + privateKey;

    this.account = privateKeyToAccount(pk);
    this.parentName = parentName;
    this.parentNode = namehash(parentName);
    this.registry = registry;
    this.resolver = resolver;
    this.quiet = quiet;

    const transport = http(rpcUrl, { retryCount: 3, retryDelay: 500 });
    this.walletClient = createWalletClient({ account: this.account, transport, chain: sepolia });
    this.publicClient = createPublicClient({ transport, chain: sepolia });
  }

  // ─── Reads ─────────────────────────────────────────────────────────────

  async getText(name, key) {
    const node = namehash(name);
    return this.publicClient.readContract({
      address: this.resolver, abi: RESOLVER_ABI, functionName: 'text', args: [node, key],
    });
  }

  async getOwner(name) {
    const node = namehash(name);
    return this.publicClient.readContract({
      address: this.registry, abi: REGISTRY_ABI, functionName: 'owner', args: [node],
    });
  }

  async getResolver(name) {
    const node = namehash(name);
    return this.publicClient.readContract({
      address: this.registry, abi: REGISTRY_ABI, functionName: 'resolver', args: [node],
    });
  }

  // ─── Writes ────────────────────────────────────────────────────────────

  /**
   * Set a text record on `name`.
   * Returns the tx hash; throws if the tx reverts.
   */
  async setText(name, key, value) {
    const node = namehash(name);
    const hash = await this.walletClient.writeContract({
      address: this.resolver,
      abi: RESOLVER_ABI,
      functionName: 'setText',
      args: [node, key, value],
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash, timeout: 60_000, pollingInterval: 1000,
    });
    if (receipt.status !== 'success') {
      throw new Error(`setText reverted for ${name}/${key}: tx=${hash}`);
    }
    this._log('setText', `${name}["${key}"] = "${this._truncValue(value)}"  tx=${hash}`);
    return hash;
  }

  /**
   * Create or update a subname (sub.parentName).
   * Sets owner = our wallet, resolver = SEPOLIA_PUBLIC_RESOLVER, ttl = 0.
   * Idempotent: if subname already exists with these params, sends the tx anyway
   * (cheap, simpler than checking).
   */
  async createSubname(label) {
    if (label.includes('.')) throw new Error(`label "${label}" must be single segment, no dots`);
    const fullName = `${label}.${this.parentName}`;
    const labelHash = labelhash(label);

    // Optional: skip if already owned by us
    const existingOwner = await this.getOwner(fullName);
    if (existingOwner.toLowerCase() === this.account.address.toLowerCase()) {
      const existingResolver = await this.getResolver(fullName);
      if (existingResolver.toLowerCase() === this.resolver.toLowerCase()) {
        this._log('subname', `${fullName} already owned + resolver set, skipping`);
        return null;
      }
    }

    const hash = await this.walletClient.writeContract({
      address: this.registry,
      abi: REGISTRY_ABI,
      functionName: 'setSubnodeRecord',
      args: [
        this.parentNode,
        labelHash,
        this.account.address,    // subname owner = us
        this.resolver,           // resolver = public resolver
        0n,                      // ttl
      ],
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash, timeout: 60_000, pollingInterval: 1000,
    });
    if (receipt.status !== 'success') {
      throw new Error(`createSubname reverted for ${fullName}: tx=${hash}`);
    }
    this._log('subname', `created ${fullName} owner=${this.account.address.slice(0, 10)}... tx=${hash}`);
    return hash;
  }

  /**
   * Convenience: set a text record on a subname, creating the subname first
   * if needed.
   */
  async setSubnameText(label, key, value) {
    const fullName = `${label}.${this.parentName}`;
    const owner = await this.getOwner(fullName);
    if (owner === '0x0000000000000000000000000000000000000000') {
      this._log('subname', `${fullName} not registered, creating...`);
      await this.createSubname(label);
    }
    return this.setText(fullName, key, value);
  }

  // ─── Best-effort wrapper used by user-runtime ──────────────────────────

  /**
   * Update parent + agent records after a successful trade settlement.
   * Best-effort: errors are logged but not thrown. Trade settlement on
   * Galileo is the source of truth; ENS is decorative.
   */
  async recordTrade({ tradeId, agentId, attestationHash, openTradeTx, settleTier1Tx, settleTier2Tx, chainExplorerBase }) {
    const ts = new Date().toISOString();
    const settleHash = settleTier2Tx || settleTier1Tx;
    const explorerUrl = chainExplorerBase ? `${chainExplorerBase}/tx/${settleHash}` : settleHash;
    const tier = settleTier2Tx ? '2' : '1';

    try {
      // Parent records: latest trade + activity counter
      await this.setText(this.parentName, 'defacts.latest_attestation', attestationHash || '');
      await this.setText(this.parentName, 'defacts.latest_settlement_tx', explorerUrl);
      await this.setText(this.parentName, 'defacts.latest_settlement_at', ts);

      // Subname records for the agent that won
      if (agentId) {
        await this.setSubnameText(agentId, 'defacts.last_trade_id', tradeId);
        await this.setSubnameText(agentId, 'defacts.last_settlement_tx', explorerUrl);
        await this.setSubnameText(agentId, 'defacts.last_tier_settled', tier);
        await this.setSubnameText(agentId, 'defacts.last_attestation', attestationHash || '');
        await this.setSubnameText(agentId, 'defacts.last_active_at', ts);
      }
      this._log('recordTrade', `success tradeId=${tradeId.slice(0, 14)}... agent=${agentId} tier=${tier}`);
      return { ok: true };
    } catch (e) {
      this._log('recordTrade', `FAILED (non-fatal): ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  _log(tag, msg) {
    if (this.quiet) return;
    console.log(`[ens ${tag}] ${msg}`);
  }

  _truncValue(v) {
    const s = String(v ?? '');
    return s.length > 60 ? s.slice(0, 57) + '...' : s;
  }
}

// ─── Default export of helper ────────────────────────────────────────────

export default EnsUpdater;
