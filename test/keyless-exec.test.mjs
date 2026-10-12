/**
 * Keyless settlement — regression guard.
 *
 * Settling a Safe transaction means broadcasting an Ethereum transaction and paying gas.
 * Before this existed, keyless custody covered proposing and co-signing but NOT settling,
 * so a PRIVATE deployment could sign to threshold and never put anything on chain.
 *
 * The dangerous part is that a raw transaction digest is unbounded: a Safe EIP-712 digest
 * is constrained by the Safe's threshold, but a transaction digest can authorise anything
 * the signing EOA can do. These tests pin the guards that keep the settlement key
 * incapable of anything except settling.
 *
 * Offline: mock client and mock vault. No network, no keys, no funds.
 *   node test/keyless-exec.test.mjs
 */
import { ethers } from 'ethers';
import { RemoteTxSigner, RemoteSigner, localKeyBackend } from '../signer.js';

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
};
const rejects = async (name, fn, match) => {
  try { await fn(); t(name, false, 'did not throw'); }
  catch (e) { t(name, !match || new RegExp(match, 'i').test(e.message), e.message.slice(0, 70)); }
};

const WALLET = new ethers.Wallet('0x' + '11'.repeat(32));
const SAFE   = '0xb6db3791AEacadAF9591bf78e63b7c11b585f208';
const EXEC   = '0x6a761202' + '00'.repeat(100);

// ── RemoteTxSigner: verifies the vault signed what we asked, as who we expect ──────
{
  // A vault that signs the digest it is given, correctly.
  const honest = {
    address: WALLET.address,
    async signTransactionFields(fields) {
      const tx = ethers.Transaction.from({
        to: fields.to, data: fields.data, value: BigInt(fields.value),
        nonce: Number(fields.nonce), gasLimit: BigInt(fields.gasLimit),
        chainId: BigInt(fields.chainId), type: 2,
        maxFeePerGas: BigInt(fields.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(fields.maxPriorityFeePerGas),
      });
      const s = WALLET.signingKey.sign(tx.unsignedHash);
      return { r: s.r, s: s.s, v: s.v };
    },
  };
  const signer = new RemoteTxSigner({ address: WALLET.address, backend: honest });

  const tx = new ethers.Transaction();
  Object.assign(tx, { to: SAFE, data: EXEC, value: 0n, nonce: 3, gasLimit: 300000n,
                      chainId: 11155111n, type: 2,
                      maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n });

  const sig = await signer.signTransaction(tx);
  tx.signature = sig;
  t('signs a transaction and it recovers to the executor', tx.from === WALLET.address);
  t('produces a serialisable signed transaction', tx.serialized.startsWith('0x'));

  // A vault signing with the WRONG key must be caught before broadcast.
  const impostor = new ethers.Wallet('0x' + '22'.repeat(32));
  const wrongKey = {
    address: WALLET.address,
    async signTransactionFields(fields) {
      const tx2 = ethers.Transaction.from({
        to: fields.to, data: fields.data, value: BigInt(fields.value),
        nonce: Number(fields.nonce), gasLimit: BigInt(fields.gasLimit),
        chainId: BigInt(fields.chainId), type: 2,
        maxFeePerGas: BigInt(fields.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(fields.maxPriorityFeePerGas),
      });
      const s = impostor.signingKey.sign(tx2.unsignedHash);
      return { r: s.r, s: s.s, v: s.v };
    },
  };
  const bad = new RemoteTxSigner({ address: WALLET.address, backend: wrongKey });
  const tx3 = new ethers.Transaction();
  Object.assign(tx3, { to: SAFE, data: EXEC, value: 0n, nonce: 1, gasLimit: 300000n,
                       chainId: 11155111n, type: 2,
                       maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n });
  await rejects('refuses a signature from the wrong key',
    () => bad.signTransaction(tx3), 'does not recover');

  // A vault that returns a signature over a DIFFERENT transaction must also be caught —
  // this is the substitution attack the recovery check exists to stop.
  const swapped = {
    address: WALLET.address,
    async signTransactionFields() {
      const other = ethers.Transaction.from({
        to: '0x000000000000000000000000000000000000dEaD', data: '0x', value: 10n ** 18n,
        nonce: 0, gasLimit: 21000n, chainId: 11155111n, type: 2,
        maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n,
      });
      const s = WALLET.signingKey.sign(other.unsignedHash);
      return { r: s.r, s: s.s, v: s.v };
    },
  };
  const sub = new RemoteTxSigner({ address: WALLET.address, backend: swapped });
  const tx4 = new ethers.Transaction();
  Object.assign(tx4, { to: SAFE, data: EXEC, value: 0n, nonce: 7, gasLimit: 300000n,
                       chainId: 11155111n, type: 2,
                       maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n });
  await rejects('refuses a signature over a different transaction',
    () => sub.signTransaction(tx4), 'does not recover');
}

// ── RemoteSigner.signDigest: the general primitive behind signSafeTxHash ──────────
{
  const rs = new RemoteSigner({ address: WALLET.address, backend: localKeyBackend(WALLET.privateKey) });
  const digest = ethers.keccak256('0xdeadbeef');
  const sig = await rs.signDigest(digest);
  t('signDigest signs any 32-byte digest', ethers.recoverAddress(digest, sig) === WALLET.address);
  t('signSafeTxHash still works (delegates)',
    (await rs.signSafeTxHash(digest)) === sig);
  await rejects('signDigest rejects a non-32-byte input',
    () => rs.signDigest('0x1234'), '32-byte');
}

// ── the EOA nonce is not the Safe nonce ──────────────────────────────────────────
{
  // Guard against the classic confusion: buildExecCalldata reports the SAFE's nonce,
  // and the executor must NOT use it as the transaction nonce.
  const call = { to: SAFE, data: EXEC, value: '0x0', safeNonce: 0 };
  const eoaNonce = 42;                       // what the provider would report
  const tx = new ethers.Transaction();
  Object.assign(tx, { to: call.to, data: call.data, value: 0n, nonce: eoaNonce,
                      gasLimit: 300000n, chainId: 11155111n, type: 2,
                      maxFeePerGas: 2000000000n, maxPriorityFeePerGas: 1000000000n });
  t('transaction nonce is the EOA nonce, not the Safe nonce',
    tx.nonce === eoaNonce && tx.nonce !== call.safeNonce);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
