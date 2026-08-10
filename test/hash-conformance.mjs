/**
 * Offline conformance test for the SAGE signing-correctness fix (TOKEN-67).
 *
 * Proves, with no network and no keys:
 *   1. The corrected path reproduces the CANONICAL Safe EIP-712 SafeTx hash
 *      (protocol-kit's own typed data == an independent ethers reference).
 *   2. The OLD hand-rolled keccak256(abiEncode(...)) hash is a DIFFERENT value
 *      — i.e. Bug 2 was real and the fix targets the right hash.
 *   3. The old `signMessage` (EIP-191 personal_sign) digest != the SafeTx hash,
 *      so the old signature recovered to the wrong preimage (Bug 1).
 *
 * Run: node test/hash-conformance.mjs
 */
import { ethers } from 'ethers';
import { generateTypedData } from '@safe-global/protocol-kit';

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// A fixed, arbitrary SafeTx vector (Sepolia chainId, dummy Safe address).
const chainId     = 11155111n;
const safeAddress = '0x1111111111111111111111111111111111111111';
const safeVersion = '1.3.0';
const safeTx = {
  to:             '0x2222222222222222222222222222222222222222',
  value:          '1000000000000000000',   // 1 ETH in wei
  data:           '0xa9059cbb0000000000000000000000003333333333333333333333333333333333333333000000000000000000000000000000000000000000000000000000000000002a',
  operation:      0,
  safeTxGas:      0,
  baseGas:        0,
  gasPrice:       0,
  gasToken:       ethers.ZeroAddress,
  refundReceiver: ethers.ZeroAddress,
  nonce:          7,
};

// ── 1. protocol-kit typed data → hash via ethers ─────────────────────────────
const typed = generateTypedData({ safeAddress, safeVersion, chainId, data: safeTx });
const { SafeTx } = typed.types;                 // strip EIP712Domain for ethers
const kitHash = ethers.TypedDataEncoder.hash(typed.domain, { SafeTx }, typed.message);

// ── 2. Independent ethers reference (canonical Safe EIP-712) ──────────────────
const domain = { chainId, verifyingContract: safeAddress };
const types  = {
  SafeTx: [
    { name: 'to',             type: 'address' },
    { name: 'value',          type: 'uint256' },
    { name: 'data',           type: 'bytes'   },
    { name: 'operation',      type: 'uint8'   },
    { name: 'safeTxGas',      type: 'uint256' },
    { name: 'baseGas',        type: 'uint256' },
    { name: 'gasPrice',       type: 'uint256' },
    { name: 'gasToken',       type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce',          type: 'uint256' },
  ],
};
const refHash = ethers.TypedDataEncoder.hash(domain, types, safeTx);

// ── 3. The OLD hand-rolled hash (Bug 2) ──────────────────────────────────────
const oldHash = ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(
    ['address','uint256','bytes','uint8','uint256','uint256','uint256','address','address','uint256'],
    [safeTx.to, safeTx.value, safeTx.data, safeTx.operation,
     safeTx.safeTxGas, safeTx.baseGas, safeTx.gasPrice,
     safeTx.gasToken, safeTx.refundReceiver, safeTx.nonce],
  ),
);

// ── 4. The OLD personal_sign digest over the (wrong) hash (Bug 1) ────────────
const personalSignDigest = ethers.hashMessage(ethers.getBytes(refHash));

console.log('canonical SafeTx hash :', refHash);
console.log('protocol-kit hash     :', kitHash);
console.log('old hand-rolled hash  :', oldHash);
console.log('');

check('protocol-kit hash == canonical ethers reference', kitHash === refHash);
check('old hand-rolled hash != canonical hash (Bug 2 confirmed)', oldHash !== refHash);
check('EIP-191 personal_sign digest != SafeTx hash (Bug 1 confirmed)', personalSignDigest !== refHash);

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
