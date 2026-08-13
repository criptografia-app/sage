/**
 * Offline tests for keyless remote signing (signer.js).
 *
 * Proves the agent never needs the private key: a backend that only exposes
 * `signDigest` is enough to produce a valid Safe owner signature, and a
 * signature that doesn't recover to the expected owner is REFUSED. The HTTP
 * backend is exercised with a mock fetch (a "vault" that signs server-side).
 *
 * Run: node test/remote-signer.mjs   (or `npm test`)
 */
import { RemoteSigner, localKeyBackend, httpSignerBackend, makeSigner } from '../signer.js';
import { ethers } from 'ethers';

let failures = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };
const throws = async (fn, re) => { try { await fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

const wallet = ethers.Wallet.createRandom();
const HASH = ethers.keccak256(ethers.toUtf8Bytes('a safe tx hash preimage')); // 32 bytes

// ── local backend: valid Safe owner signature, no key exposure ────────────────
{
  const signer = new RemoteSigner({ address: wallet.address, backend: localKeyBackend(wallet.privateKey) });
  const sig = await signer.signSafeTxHash(HASH);

  check('signature is 65 bytes (r||s||v)', ethers.getBytes(sig).length === 65);
  check('recovers to the owner address', ethers.recoverAddress(HASH, sig) === wallet.address);
  check('v is 27 or 28 (EIP-712 owner sig)', [27, 28].includes(ethers.Signature.from(sig).v));
  check('matches what ethers SigningKey produces', sig === new ethers.SigningKey(wallet.privateKey).sign(HASH).serialized);
  check('getAddress returns the owner', signer.getAddress() === wallet.address);

  // The agent holds NO private key — the backend exposes only address + signDigest.
  const backend = localKeyBackend(wallet.privateKey);
  check('backend exposes no privateKey', backend.privateKey === undefined && !('privateKey' in backend));
  check('RemoteSigner exposes no privateKey', signer.privateKey === undefined);
}

// ── digest hygiene ────────────────────────────────────────────────────────────
{
  const signer = new RemoteSigner({ address: wallet.address, backend: localKeyBackend(wallet.privateKey) });
  check('rejects a non-32-byte hash', await throws(() => signer.signSafeTxHash('0x1234'), /32-byte/));
}

// ── backend that returns recovery-id form v∈{0,1} is normalized ───────────────
{
  const raw = new ethers.SigningKey(wallet.privateKey).sign(HASH);
  const yParityBackend = { async signDigest() { return { r: raw.r, s: raw.s, v: raw.yParity }; } }; // v = 0/1
  const signer = new RemoteSigner({ address: wallet.address, backend: yParityBackend });
  const sig = await signer.signSafeTxHash(HASH);
  check('normalizes v from recovery-id (0/1) to 27/28', ethers.recoverAddress(HASH, sig) === wallet.address);
}

// ── backend that returns NO v: RemoteSigner recovers it by trying 27/28 ───────
{
  const raw = new ethers.SigningKey(wallet.privateKey).sign(HASH);
  const noVBackend = { async signDigest() { return { r: raw.r, s: raw.s }; } };
  const signer = new RemoteSigner({ address: wallet.address, backend: noVBackend });
  const sig = await signer.signSafeTxHash(HASH);
  check('derives v when the vault returns only { r, s }', ethers.recoverAddress(HASH, sig) === wallet.address);
}

// ── SECURITY: a wrong/compromised vault key is refused ────────────────────────
{
  const other = ethers.Wallet.createRandom();
  // backend signs with a DIFFERENT key than the owner address we expect.
  const wrongBackend = { async signDigest(d) { const s = new ethers.SigningKey(other.privateKey).sign(d); return { r: s.r, s: s.s, v: s.v }; } };
  const signer = new RemoteSigner({ address: wallet.address, backend: wrongBackend });
  check('refuses a signature that does not recover to the expected owner',
    await throws(() => signer.signSafeTxHash(HASH), /does not recover to the expected owner/));
}

// ── HTTP backend: a "vault" that signs server-side, key never leaves it ───────
{
  // Mock vault: holds the key, signs the digest, returns only { r, s }.
  const vaultFetch = async (url, opts) => {
    const { digest } = JSON.parse(opts.body);
    const s = new ethers.SigningKey(wallet.privateKey).sign(digest);
    return { ok: true, status: 200, json: async () => ({ r: s.r, s: s.s }) };
  };
  const signer = new RemoteSigner({
    address: wallet.address,
    backend: httpSignerBackend({ endpoint: 'https://vault.local/sign', keyRef: 'agent/exec', fetchImpl: vaultFetch }),
  });
  const sig = await signer.signSafeTxHash(HASH);
  check('HTTP vault backend produces a valid owner signature', ethers.recoverAddress(HASH, sig) === wallet.address);

  // Malicious vault returns a signature from the wrong key → refused.
  const evil = ethers.Wallet.createRandom();
  const evilFetch = async (url, opts) => {
    const { digest } = JSON.parse(opts.body);
    const s = new ethers.SigningKey(evil.privateKey).sign(digest);
    return { ok: true, status: 200, json: async () => ({ r: s.r, s: s.s }) };
  };
  const evilSigner = new RemoteSigner({ address: wallet.address, backend: httpSignerBackend({ endpoint: 'x', keyRef: 'k', fetchImpl: evilFetch }) });
  check('HTTP: wrong-key vault response is refused', await throws(() => evilSigner.signSafeTxHash(HASH), /does not recover/));

  // A vault error surfaces.
  const errFetch = async () => ({ ok: false, status: 503 });
  const errSigner = new RemoteSigner({ address: wallet.address, backend: httpSignerBackend({ endpoint: 'x', keyRef: 'k', fetchImpl: errFetch }) });
  check('HTTP: vault error surfaces', await throws(() => errSigner.signSafeTxHash(HASH), /HTTP 503/));
}

// ── makeSigner factory ────────────────────────────────────────────────────────
check('makeSigner local builds', makeSigner({ backend: 'local', privateKey: wallet.privateKey }).getAddress() === wallet.address);
check('makeSigner http builds', makeSigner({ backend: 'http', address: wallet.address, endpoint: 'x', keyRef: 'k', fetchImpl: async()=>({}) }) instanceof RemoteSigner);
check('makeSigner unknown backend throws', (() => { try { makeSigner({ backend: 'nope' }); return false; } catch { return true; } })());
check('httpSignerBackend requires endpoint + keyRef', (() => { try { httpSignerBackend({}); return false; } catch { return true; } })());

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
