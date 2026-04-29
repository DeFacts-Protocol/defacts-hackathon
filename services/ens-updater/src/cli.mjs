#!/usr/bin/env node
/**
 * defacts-ens — manual ENS record management for the marketplace.
 *
 * Usage:
 *   defacts-ens read <name> <key>
 *   defacts-ens set <name> <key> <value>
 *   defacts-ens create <label>                    # creates label.defacts.eth
 *   defacts-ens setup                             # creates l4, l40s, h100 + initial records
 *   defacts-ens dump <name>                       # dumps known text records
 *
 * Requires ENS_OWNER_PRIVKEY env var set.
 */

import { EnsUpdater } from './index.mjs';

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log('Usage:');
  console.log('  defacts-ens read <name> <key>');
  console.log('  defacts-ens set <name> <key> <value>');
  console.log('  defacts-ens create <label>                # creates label.defacts.eth');
  console.log('  defacts-ens setup                         # creates l4, l40s, h100 subnames');
  console.log('  defacts-ens dump <name>                   # show known records');
  console.log('');
  console.log('Required env: ENS_OWNER_PRIVKEY');
  console.log('Optional env: SEPOLIA_RPC_URL (default: publicnode)');
  // --help/-h is success; no args is error (invocation form is wrong)
  process.exit(args.length === 0 ? 1 : 0);
}

const privKey = process.env.ENS_OWNER_PRIVKEY;
if (!privKey) {
  console.error('FATAL: ENS_OWNER_PRIVKEY env var not set');
  console.error('Derive from your ENS owner wallet (the one that owns defacts.eth on Sepolia)');
  process.exit(1);
}

const ens = new EnsUpdater({
  privateKey: privKey,
  rpcUrl: process.env.SEPOLIA_RPC_URL,
});

const cmd = args[0];

try {
  if (cmd === 'read') {
    const [, name, key] = args;
    if (!name || !key) { console.error('Usage: defacts-ens read <name> <key>'); process.exit(1); }
    const val = await ens.getText(name, key);
    console.log(`${name}["${key}"] = ${JSON.stringify(val)}`);
  }

  else if (cmd === 'set') {
    const [, name, key, value] = args;
    if (!name || !key || value === undefined) { console.error('Usage: defacts-ens set <name> <key> <value>'); process.exit(1); }
    await ens.setText(name, key, value);
  }

  else if (cmd === 'create') {
    const [, label] = args;
    if (!label) { console.error('Usage: defacts-ens create <label>'); process.exit(1); }
    await ens.createSubname(label);
  }

  else if (cmd === 'setup') {
    console.log('Setting up DeFacts hardware-tier subnames + initial records...\n');
    const tiers = [
      { label: 'l4',   description: 'L4-class supplier (cache-mode-agent)',   gpu_class: 'NVIDIA L4'    },
      { label: 'l40s', description: 'L40S-class supplier (fresh-mode-agent)', gpu_class: 'NVIDIA L40S'  },
      { label: 'h100', description: 'H100-class supplier (fresh-mode-agent)', gpu_class: 'NVIDIA H100'  },
    ];
    for (const t of tiers) {
      await ens.createSubname(t.label);
      await ens.setSubnameText(t.label, 'description', t.description);
      await ens.setSubnameText(t.label, 'defacts.gpu_class', t.gpu_class);
      await ens.setSubnameText(t.label, 'defacts.proof_format', 'stub-v1');
      await ens.setSubnameText(t.label, 'defacts.last_active_at', new Date().toISOString());
      console.log('');
    }
    // Parent records
    await ens.setText('defacts.eth', 'description', 'DeFacts: marketplace for verified LLM inference');
    await ens.setText('defacts.eth', 'url', 'https://github.com/Paradatum-Inc/defacts');
    await ens.setText('defacts.eth', 'defacts.escrow_addr', '0xF49490aCd9c3Fb548c57BafF7034cD686827a641');
    await ens.setText('defacts.eth', 'defacts.escrow_chain', '0g-galileo-16602');
    await ens.setText('defacts.eth', 'defacts.verifier_registry', '0xD02b5855E0c0F50DB9555417cC269c2F19fbA0B2');
    console.log('\nSetup complete.');
  }

  else if (cmd === 'dump') {
    const [, name] = args;
    if (!name) { console.error('Usage: defacts-ens dump <name>'); process.exit(1); }
    const knownKeys = [
      'url', 'avatar', 'description', 'com.twitter', 'com.github',
      'defacts.escrow_addr', 'defacts.escrow_chain', 'defacts.verifier_registry',
      'defacts.latest_attestation', 'defacts.latest_settlement_tx', 'defacts.latest_settlement_at',
      'defacts.gpu_class', 'defacts.proof_format',
      'defacts.last_trade_id', 'defacts.last_settlement_tx', 'defacts.last_tier_settled',
      'defacts.last_attestation', 'defacts.last_active_at',
    ];
    console.log(`Records for ${name}:`);
    for (const k of knownKeys) {
      const v = await ens.getText(name, k);
      if (v && v.length > 0) {
        const trunc = v.length > 70 ? v.slice(0, 67) + '...' : v;
        console.log(`  ${k.padEnd(40)} = ${JSON.stringify(trunc)}`);
      }
    }
  }

  else {
    console.error(`Unknown command: ${cmd}`);
    console.error('Run with --help for usage');
    process.exit(1);
  }
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
