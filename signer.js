/**
 * SAGE — Keyless remote signing
 *
 * NO seed or private key ever lives with the agents. When a signature is needed,
 * the agent computes the digest and makes a REQUEST to the vault (Warden /
 * HashiCorp Vault / any remote signer); the vault holds the key and returns only
 * a signature. The agent process can request signatures — gated by policy and
 * hardware 2FA — but can never exfiltrate the key, because it never has it.
 *
 * A Safe owner's EIP-712 signature is just an ECDSA signature over the 32-byte
 * `safeTxHash`, with v ∈ {27,28}. So a backend only needs one capability:
 * `signDigest(digest) → { r, s }` (v optional). RemoteSigner assembles the Safe
 * owner signature and — critically — VERIFIES it recovers to the expected owner
 * address before returning it, so a compromised or wrong vault key is caught.
 *
 * Backends:
 *   - localKeyBackend(pk)  — in-memory key. DEV / SAGE-free tier / tests ONLY.
 *                            This is the one mode where a key is in process memory.
 *   - httpSignerBackend()  — generic remote signer over HTTP: POST { keyRef,
 *                            digest } → { r, s }. Warden / Vault Transit / a KMS
 *                            signing service are configured through this.
 */
import { ethers } from 'ethers';

// ── Backends ──────────────────────────────────────────────────────────────────

/**
 * In-memory key backend. The ONLY backend where a private key exists in the
 * agent process — reserved for local dev, the SAGE free tier, and tests. PRIVATE
 * deployments use a remote backend so no key is ever present.
 */
export function localKeyBackend(privateKey) {
  const key = new ethers.SigningKey(privateKey);
  const address = ethers.computeAddress(key.publicKey);
  return {
    kind: 'local',
    address,
    async signDigest(digest) {
      const sig = key.sign(digest);            // ECDSA over the 32-byte digest
      return { r: sig.r, s: sig.s, v: sig.v }; // v is 27/28
    },
  };
}

/**
 * Generic remote-signer backend. POSTs the digest to a signing endpoint that
 * holds the key (Warden keychain, Vault Transit, KMS) and returns { r, s }.
 * The private key never leaves the vault. `fetchImpl` is injectable for tests.
 *
 * @param {{ endpoint:string, keyRef:string, headers?:object, address?:string, fetchImpl?:Function }} cfg
 */
export function httpSignerBackend({ endpoint, keyRef, headers = {}, address, fetchImpl } = {}) {
  if (!endpoint || !keyRef) throw new Error('httpSignerBackend: endpoint and keyRef are required');
  const doFetch = fetchImpl || globalThis.fetch;
  if (!doFetch) throw new Error('httpSignerBackend: no fetch available (pass fetchImpl)');
  return {
    kind: 'http',
    address,
    async signDigest(digest) {
      const res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ keyRef, digest }),
      });
      if (!res.ok) throw new Error(`remote signer HTTP ${res.status}`);
      const out = await res.json();
      if (!out || !out.r || !out.s) throw new Error('remote signer returned no { r, s }');
      return { r: out.r, s: out.s, v: out.v };
    },
  };
}

// ── RemoteSigner: assembles + verifies the Safe owner signature ───────────────

export class RemoteSigner {
  /**
   * @param {{ address:string, backend:object }} opts
   *   address — the Safe owner address this key corresponds to (verification target)
   *   backend — a { signDigest(digest) } backend (local or remote)
   */
  constructor({ address, backend }) {
    if (!backend) throw new Error('RemoteSigner: a backend is required');
    this.address = ethers.getAddress(address || backend.address);
    this.backend = backend;
  }

  getAddress() { return this.address; }

  /**
   * Sign a Safe transaction hash and return the 65-byte EIP-712 owner signature
   * (r||s||v, v∈{27,28}). Verifies recovery to this.address — a signature that
   * doesn't recover to the expected owner is refused (a wrong/compromised vault
   * key can never be silently submitted).
   *
   * @param {string} safeTxHash - 0x-prefixed 32-byte EIP-712 SafeTx hash
   * @returns {Promise<string>} serialized 65-byte signature
   */
  async signSafeTxHash(safeTxHash) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(safeTxHash)) throw new Error('signSafeTxHash: expected a 32-byte hex hash');
    const raw = await this.backend.signDigest(safeTxHash);
    if (!raw || !raw.r || !raw.s) throw new Error('backend returned no { r, s }');

    // Determine v: honour a valid provided v, else recover it by trying 27/28.
    const candidates = [];
    if (raw.v === 27 || raw.v === 28) candidates.push(raw.v);
    else if (raw.v === 0 || raw.v === 1) candidates.push(raw.v + 27);
    candidates.push(27, 28);

    for (const v of candidates) {
      let recovered;
      try { recovered = ethers.recoverAddress(safeTxHash, { r: raw.r, s: raw.s, v }); }
      catch { continue; }
      if (recovered === this.address) {
        return ethers.Signature.from({ r: raw.r, s: raw.s, v }).serialized;
      }
    }
    throw new Error(`remote signature does not recover to the expected owner ${this.address} — refusing to submit`);
  }
}

/**
 * Build a signer from config. PRIVATE deployments set keys.backend to a remote
 * vault so no key is ever in the agent; the local backend is the free-tier path.
 *
 * @param {object} spec
 *   { backend:'local', privateKey } |
 *   { backend:'http'|'warden'|'vault', address, endpoint, keyRef, headers, fetchImpl }
 */
export function makeSigner(spec = {}) {
  switch (spec.backend) {
    case 'local':
      return new RemoteSigner({ address: spec.address, backend: localKeyBackend(spec.privateKey) });
    case 'http':
    case 'warden':   // Warden keychain and Vault Transit both speak the generic
    case 'vault': {  // "POST digest → { r, s }" contract; endpoint/keyRef differ.
      const backend = httpSignerBackend(spec);
      return new RemoteSigner({ address: spec.address, backend });
    }
    default:
      throw new Error(`makeSigner: unknown backend "${spec.backend}" (local | http | warden | vault)`);
  }
}
