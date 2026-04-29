import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, encodeAbiParameters, encodePacked, toBytes, recoverTypedDataAddress } from 'viem';
import { writeFileSync } from 'fs';

const VERIFYING_CONTRACT = '0x0000000000000000000000000000000000000001';
const CHAIN_ID = 16602;
const PRIVKEY = '0x' + 'a'.repeat(64);
const account = privateKeyToAccount(PRIVKEY);
const domain = { name: 'DeFacts', version: '1', chainId: CHAIN_ID, verifyingContract: VERIFYING_CONTRACT };

const tier1Types = { Tier1Attestation: [
  { name: 'psec_version', type: 'bytes32' }, { name: 'model_commitment', type: 'bytes32' },
  { name: 'input_hash', type: 'bytes32' }, { name: 'output_hash', type: 'bytes32' },
  { name: 'tier', type: 'uint8' }
]};
const tier2Types = { Tier2Attestation: [
  { name: 'psec_version', type: 'bytes32' }, { name: 'model_commitment', type: 'bytes32' },
  { name: 'input_hash', type: 'bytes32' }, { name: 'output_hash', type: 'bytes32' },
  { name: 'tier', type: 'uint8' }, { name: 'buyer_pubkey', type: 'bytes' }
]};

function packU32BE(ids) {
  const buf = Buffer.alloc(ids.length * 4);
  ids.forEach((id, i) => buf.writeUInt32BE(id, i * 4));
  return '0x' + buf.toString('hex');
}

const INPUT_IDS = [785, 6722, 315, 9625, 374];
const OUTPUT_IDS = [12095, 13, 576, 6722, 315, 17689, 374, 24081, 13, 576, 6722, 315, 15344, 374, 21718, 13, 576, 6722, 315, 9856];
const inputHash = keccak256(packU32BE(INPUT_IDS));
const outputHash = keccak256(packU32BE(OUTPUT_IDS));
const PSEC_VERSION = '0x' + '11'.repeat(32);
const MODEL_COMMITMENT = '0x' + '22'.repeat(32);
const BUYER_PUBKEY = '0x02' + 'cd'.repeat(32);

const tier1Message = { psec_version: PSEC_VERSION, model_commitment: MODEL_COMMITMENT, input_hash: inputHash, output_hash: outputHash, tier: 1 };
const tier2Message = { psec_version: PSEC_VERSION, model_commitment: MODEL_COMMITMENT, input_hash: inputHash, output_hash: outputHash, tier: 2, buyer_pubkey: BUYER_PUBKEY };

const DOMAIN_TYPEHASH = keccak256(toBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
const TIER1_TYPEHASH = keccak256(toBytes('Tier1Attestation(bytes32 psec_version,bytes32 model_commitment,bytes32 input_hash,bytes32 output_hash,uint8 tier)'));
const TIER2_TYPEHASH = keccak256(toBytes('Tier2Attestation(bytes32 psec_version,bytes32 model_commitment,bytes32 input_hash,bytes32 output_hash,uint8 tier,bytes buyer_pubkey)'));

const domainSeparator = keccak256(encodeAbiParameters(
  [{type:'bytes32'},{type:'bytes32'},{type:'bytes32'},{type:'uint256'},{type:'address'}],
  [DOMAIN_TYPEHASH, keccak256(toBytes('DeFacts')), keccak256(toBytes('1')), BigInt(CHAIN_ID), VERIFYING_CONTRACT]
));

const tier1StructHash = keccak256(encodeAbiParameters(
  [{type:'bytes32'},{type:'bytes32'},{type:'bytes32'},{type:'bytes32'},{type:'bytes32'},{type:'uint8'}],
  [TIER1_TYPEHASH, tier1Message.psec_version, tier1Message.model_commitment, tier1Message.input_hash, tier1Message.output_hash, tier1Message.tier]
));

const tier2StructHash = keccak256(encodeAbiParameters(
  [{type:'bytes32'},{type:'bytes32'},{type:'bytes32'},{type:'bytes32'},{type:'bytes32'},{type:'uint8'},{type:'bytes32'}],
  [TIER2_TYPEHASH, tier2Message.psec_version, tier2Message.model_commitment, tier2Message.input_hash, tier2Message.output_hash, tier2Message.tier, keccak256(tier2Message.buyer_pubkey)]
));

const tier1Digest = keccak256(encodePacked(['bytes2','bytes32','bytes32'], ['0x1901', domainSeparator, tier1StructHash]));
const tier2Digest = keccak256(encodePacked(['bytes2','bytes32','bytes32'], ['0x1901', domainSeparator, tier2StructHash]));

const tier1Signature = await account.signTypedData({ domain, types: tier1Types, primaryType: 'Tier1Attestation', message: tier1Message });
const tier2Signature = await account.signTypedData({ domain, types: tier2Types, primaryType: 'Tier2Attestation', message: tier2Message });

const tier1Recovered = await recoverTypedDataAddress({ domain, types: tier1Types, primaryType: 'Tier1Attestation', message: tier1Message, signature: tier1Signature });
const tier2Recovered = await recoverTypedDataAddress({ domain, types: tier2Types, primaryType: 'Tier2Attestation', message: tier2Message, signature: tier2Signature });

if (tier1Recovered.toLowerCase() !== account.address.toLowerCase()) throw new Error('tier1 recovery mismatch');
if (tier2Recovered.toLowerCase() !== account.address.toLowerCase()) throw new Error('tier2 recovery mismatch');

const fixtures = {
  chainId: CHAIN_ID, verifyingContract: VERIFYING_CONTRACT, privateKey: PRIVKEY,
  expectedSigner: account.address, domainSeparator,
  tier1: {
    typeString: 'Tier1Attestation(bytes32 psec_version,bytes32 model_commitment,bytes32 input_hash,bytes32 output_hash,uint8 tier)',
    typeHash: TIER1_TYPEHASH, message: tier1Message,
    structHash: tier1StructHash, digest: tier1Digest, signature: tier1Signature
  },
  tier2: {
    typeString: 'Tier2Attestation(bytes32 psec_version,bytes32 model_commitment,bytes32 input_hash,bytes32 output_hash,uint8 tier,bytes buyer_pubkey)',
    typeHash: TIER2_TYPEHASH,
    message: { ...tier2Message, buyer_pubkey_hash: keccak256(tier2Message.buyer_pubkey) },
    structHash: tier2StructHash, digest: tier2Digest, signature: tier2Signature
  },
  canonical: {
    input_token_ids: INPUT_IDS, output_token_ids: OUTPUT_IDS,
    input_hash: inputHash, output_hash: outputHash
  }
};

writeFileSync('./fixtures.json', JSON.stringify(fixtures, null, 2));
console.log('signer            :', account.address);
console.log('tier1.digest      :', tier1Digest);
console.log('tier1.recovered   :', tier1Recovered, '✓');
console.log('tier2.digest      :', tier2Digest);
console.log('tier2.recovered   :', tier2Recovered, '✓');
console.log('canonical.input_h :', inputHash);
console.log('canonical.output_h:', outputHash);
console.log('written           : fixtures.json');
