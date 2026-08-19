/**
 * SAGE — Hardware 2FA on the human authorization layer
 *
 * In the "2 agents + your OK" model the two agents supply both on-chain
 * signatures; the owner's *instruction* is the human co-signature. This module
 * hardens that instruction with a **hardware second factor** — a physical touch
 * on a Trezor or a YubiKey — cryptographically bound to the EXACT batch the
 * owner reviewed. No valid, fresh, batch-bound proof ⇒ the signing agent refuses
 * (fail-closed).
 *
 * Two device types behind one interface:
 *   - hardware wallet (Trezor, Ledger, any EOA): an EIP-712 signature over the
 *     authorization struct, verified by address recovery (ethers).
 *   - YubiKey / FIDO2 (WebAuthn): a P-256 assertion over a challenge that binds
 *     the batch, verified with Node crypto (no external dependency).
 *
 * Both bind the SAME request `{ operator, safeTxHashes (sorted), nonce, issuedAt,
 * expiresAt }`, so a proof authorizes exactly one batch, once, within a TTL.
 *
 * Threat model — this is an OFF-CHAIN gate. It hardens the instruction channel
 * (a stolen session can't authorize without the device). It does NOT protect
 * against a fully compromised signing-agent host, which holds the execution key
 * and could bypass a software gate — for that, register the device as a real
 * Safe owner (on-chain threshold), tracked as a roadmap option.
 */
import { ethers } from 'ethers';
import { createHash, createVerify, createPublicKey } from 'crypto';

// ── Canonical authorization request (the thing both factors bind to) ──────────

/**
 * Build the canonical authorization request for a batch. `safeTxHashes` are
 * lowercased + sorted so the binding is order-independent and stable.
 */
export function buildAuthorizationRequest(operator, safeTxHashes, { nonce, issuedAt = Date.now(), ttlMs = 120_000 } = {}) {
  if (!operator) throw new Error('authorization request: operator required');
  if (!nonce)    throw new Error('authorization request: nonce required (replay protection)');
  const hashes = [...new Set((safeTxHashes || []).map(h => String(h).toLowerCase()))].sort();
  if (hashes.length === 0) throw new Error('authorization request: at least one safeTxHash required');
  return {
    operator,
    safeTxHashes: hashes,
    nonce:        String(nonce),
    issuedAt,
    expiresAt:    issuedAt + ttlMs,
  };
}

/** Stable JSON of a request — the preimage the WebAuthn challenge hashes. */
function canonicalJSON(req) {
  // Keys emitted in a fixed order so the digest is deterministic across hosts.
  return JSON.stringify({
    operator:     req.operator,
    safeTxHashes: req.safeTxHashes,
    nonce:        req.nonce,
    issuedAt:     req.issuedAt,
    expiresAt:    req.expiresAt,
  });
}

/** The 32-byte challenge a WebAuthn authenticator signs (bind = sha256 of the request). */
export function authorizationChallenge(req) {
  return createHash('sha256').update(canonicalJSON(req)).digest();
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(String(s), 'base64url');

// ── EIP-712 typed data (hardware wallets: Trezor / Ledger / EOA) ──────────────

const EIP712_DOMAIN = { name: 'SAGE Authorization', version: '1' };
const EIP712_TYPES  = {
  Authorization: [
    { name: 'operator',     type: 'string'    },
    { name: 'safeTxHashes', type: 'bytes32[]' },
    { name: 'nonce',        type: 'string'    },
    { name: 'issuedAt',     type: 'uint256'   },
    { name: 'expiresAt',    type: 'uint256'   },
  ],
};

/** The exact typed-data payload the operator's hardware wallet signs. */
export function eip712Payload(req) {
  return { domain: EIP712_DOMAIN, types: EIP712_TYPES, message: {
    operator: req.operator, safeTxHashes: req.safeTxHashes,
    nonce: req.nonce, issuedAt: req.issuedAt, expiresAt: req.expiresAt,
  } };
}

// ── Verification ──────────────────────────────────────────────────────────────

function assertFresh(req, now) {
  if (typeof req.expiresAt !== 'number' || typeof req.issuedAt !== 'number') {
    throw new Error('authorization: malformed timestamps');
  }
  if (now > req.expiresAt) throw new Error('authorization: proof expired');
  if (req.issuedAt > now + 30_000) throw new Error('authorization: issuedAt is in the future');
}

function assertBindsBatch(req, expectedHashes) {
  const want = [...new Set((expectedHashes || []).map(h => String(h).toLowerCase()))].sort();
  const got  = [...(req.safeTxHashes || [])].map(h => String(h).toLowerCase()).sort();
  if (want.length !== got.length || want.some((h, i) => h !== got[i])) {
    throw new Error('authorization: proof does not bind this exact batch of transactions');
  }
}

/**
 * Verify a hardware-wallet (EIP-712) authorization.
 * @returns {{ device: string }} the recovered device address
 * @throws on any mismatch (fail-closed)
 */
export function verifyHardwareWalletAuthorization(req, signature, { registeredAddress }) {
  if (!registeredAddress) throw new Error('authorization: no hardware-wallet device registered for this operator');
  const { domain, types, message } = eip712Payload(req);
  let recovered;
  try { recovered = ethers.verifyTypedData(domain, types, message, signature); }
  catch { throw new Error('authorization: invalid EIP-712 signature'); }
  if (ethers.getAddress(recovered) !== ethers.getAddress(registeredAddress)) {
    throw new Error('authorization: signature is not from the registered device');
  }
  return { device: ethers.getAddress(recovered) };
}

/**
 * Verify a YubiKey / FIDO2 (WebAuthn) assertion over the batch challenge.
 * `publicKey` is the registered credential public key as SPKI PEM (a COSE→SPKI
 * adapter runs once at registration for a real authenticator).
 * @returns {{ device: 'webauthn' }}
 * @throws on any mismatch (fail-closed)
 */
export function verifyWebAuthnAuthorization(req, assertion, { publicKey }) {
  if (!publicKey) throw new Error('authorization: no WebAuthn credential registered for this operator');
  const { authenticatorData, clientDataJSON, signature } = assertion || {};
  if (!authenticatorData || !clientDataJSON || !signature) {
    throw new Error('authorization: incomplete WebAuthn assertion');
  }

  const authData    = fromB64url(authenticatorData);
  const clientBytes = fromB64url(clientDataJSON);

  // 1. clientData: a genuine "get", carrying our exact challenge.
  let clientData;
  try { clientData = JSON.parse(clientBytes.toString('utf8')); }
  catch { throw new Error('authorization: unparseable clientDataJSON'); }
  if (clientData.type !== 'webauthn.get') throw new Error('authorization: wrong WebAuthn operation');
  const expected = b64url(authorizationChallenge(req));
  if (clientData.challenge !== expected) {
    throw new Error('authorization: WebAuthn challenge does not bind this batch');
  }

  // 2. User-presence flag must be set (bit 0 of authenticatorData[32]).
  if (authData.length < 37 || (authData[32] & 0x01) !== 0x01) {
    throw new Error('authorization: WebAuthn user-presence flag not set');
  }

  // 3. Signature over authenticatorData || SHA256(clientDataJSON).
  const clientHash    = createHash('sha256').update(clientBytes).digest();
  const signatureBase = Buffer.concat([authData, clientHash]);
  let key;
  try { key = createPublicKey(publicKey); }
  catch { throw new Error('authorization: unreadable registered public key'); }
  const ok = createVerify('sha256').update(signatureBase).verify(key, fromB64url(signature));
  if (!ok) throw new Error('authorization: WebAuthn signature verification failed');

  return { device: 'webauthn' };
}

// ── Registry + replay store + the composed authorizer ─────────────────────────

/** In-memory nonce store (one-time use). Swap for a shared store in production. */
export function memoryNonceStore() {
  const used = new Set();
  return {
    check(operator, nonce) {
      const key = `${operator}:${nonce}`;
      if (used.has(key)) throw new Error('authorization: nonce already used (replay)');
    },
    consume(operator, nonce) { used.add(`${operator}:${nonce}`); },
  };
}

/**
 * Compose an `authorize(operator, safeTxHashes, proof)` gate suitable for
 * batchOps.approveAll's `opts.authorize`. It verifies freshness, batch binding,
 * replay, and the device proof; throws (⇒ refuse the whole batch) on any failure.
 *
 * @param {(operator:string) => ({ type:'hw-wallet', address:string } | { type:'webauthn', publicKey:string } | null)} deviceFor
 *        resolves the operator's registered device.
 * @param {{ nonceStore?: object, now?: () => number }} [opts]
 */
export function makeAuthorizer(deviceFor, { nonceStore = memoryNonceStore(), now = Date.now } = {}) {
  return async function authorize(operator, safeTxHashes, proof) {
    if (!proof || !proof.request || !proof.type) {
      throw new Error('authorization required: a hardware 2FA proof (Trezor or YubiKey) must accompany this batch');
    }
    const req = proof.request;
    if (req.operator !== operator) throw new Error('authorization: proof operator does not match the session operator');

    const device = deviceFor(operator);
    if (!device) throw new Error(`authorization: no 2FA device registered for operator ${operator}`);

    assertFresh(req, now());
    assertBindsBatch(req, safeTxHashes);
    nonceStore.check(operator, req.nonce);

    if (proof.type === 'hw-wallet') {
      if (device.type !== 'hw-wallet') throw new Error('authorization: operator is not registered for a hardware wallet');
      verifyHardwareWalletAuthorization(req, proof.signature, { registeredAddress: device.address });
    } else if (proof.type === 'webauthn') {
      if (device.type !== 'webauthn') throw new Error('authorization: operator is not registered for a WebAuthn key');
      verifyWebAuthnAuthorization(req, proof.assertion, { publicKey: device.publicKey });
    } else {
      throw new Error(`authorization: unknown proof type "${proof.type}"`);
    }

    // Success — burn the nonce so the same proof can never be replayed.
    nonceStore.consume(operator, req.nonce);
    return { ok: true, operator, device: device.type };
  };
}
