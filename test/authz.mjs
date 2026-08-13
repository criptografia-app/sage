/**
 * Offline tests for the hardware-2FA authorization layer (authz.js).
 *
 * Exercises BOTH factors with REAL cryptography, no network/devices:
 *   - hardware wallet (Trezor/EOA): a genuine EIP-712 signature (ethers)
 *   - YubiKey / FIDO2: a genuine P-256 WebAuthn assertion (Node crypto)
 * plus freshness (TTL), batch-binding, replay (nonce), and the composed
 * makeAuthorizer() gate that batchOps.approveAll uses.
 *
 * Run: node test/authz.mjs   (or `npm test`)
 */
import {
  buildAuthorizationRequest, authorizationChallenge, eip712Payload,
  verifyHardwareWalletAuthorization, verifyWebAuthnAuthorization,
  makeAuthorizer, memoryNonceStore,
} from '../authz.js';
import { ethers } from 'ethers';
import { generateKeyPairSync, createSign, createHash } from 'crypto';

let failures = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };
const throws = async (fn, re) => { try { await fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

const b64url = (b) => Buffer.from(b).toString('base64url');
const HASHES = [
  '0x1111111111111111111111111111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222222222222222222222222222',
];

// ── Hardware wallet (EIP-712) ─────────────────────────────────────────────────
const wallet = ethers.Wallet.createRandom();
async function hwProof(req) {
  const { domain, types, message } = eip712Payload(req);
  return wallet.signTypedData(domain, types, message);
}

{
  const req = buildAuthorizationRequest('owner@corp.com', HASHES, { nonce: 'n1' });
  const sig = await hwProof(req);
  check('EIP-712: valid signature from registered device → ok', (() => {
    const r = verifyHardwareWalletAuthorization(req, sig, { registeredAddress: wallet.address });
    return r.device.toLowerCase() === wallet.address.toLowerCase();
  })());
  check('EIP-712: signature from a DIFFERENT address → reject',
    await throws(() => verifyHardwareWalletAuthorization(req, sig, { registeredAddress: ethers.Wallet.createRandom().address }),
      /not from the registered device/));
  check('EIP-712: tampered signature → reject',
    await throws(() => verifyHardwareWalletAuthorization(req, sig.slice(0, -2) + (sig.endsWith('0') ? '1' : '0'), { registeredAddress: wallet.address })));
  check('EIP-712: no device registered → reject',
    await throws(() => verifyHardwareWalletAuthorization(req, sig, {}), /no hardware-wallet device/));
}

// ── YubiKey / FIDO2 (WebAuthn P-256) ──────────────────────────────────────────
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

/** Build a real WebAuthn assertion over a request's challenge. */
function webauthnAssertion(req, { userPresent = true } = {}) {
  const clientData = JSON.stringify({
    type: 'webauthn.get',
    challenge: b64url(authorizationChallenge(req)),
    origin: 'https://sage.local',
  });
  const clientBytes = Buffer.from(clientData, 'utf8');
  const rpIdHash = createHash('sha256').update('sage.local').digest();
  const flags = Buffer.from([userPresent ? 0x01 : 0x00]);
  const counter = Buffer.from([0, 0, 0, 1]);
  const authData = Buffer.concat([rpIdHash, flags, counter]);         // 37 bytes
  const clientHash = createHash('sha256').update(clientBytes).digest();
  const signatureBase = Buffer.concat([authData, clientHash]);
  const signature = createSign('sha256').update(signatureBase).sign(privateKey);
  return {
    authenticatorData: b64url(authData),
    clientDataJSON:    b64url(clientBytes),
    signature:         b64url(signature),
  };
}

{
  const req = buildAuthorizationRequest('owner@corp.com', HASHES, { nonce: 'w1' });
  const assertion = webauthnAssertion(req);
  check('WebAuthn: valid P-256 assertion → ok',
    verifyWebAuthnAuthorization(req, assertion, { publicKey: pubPem }).device === 'webauthn');
  check('WebAuthn: challenge for a DIFFERENT batch → reject', await throws(() => {
    const other = buildAuthorizationRequest('owner@corp.com', ['0x33' + '3'.repeat(62)], { nonce: 'w1b' });
    return verifyWebAuthnAuthorization(other, assertion, { publicKey: pubPem });
  }, /does not bind this batch/));
  check('WebAuthn: user-presence flag not set → reject',
    await throws(() => verifyWebAuthnAuthorization(req, webauthnAssertion(req, { userPresent: false }), { publicKey: pubPem }),
      /user-presence/));
  check('WebAuthn: tampered signature → reject', await throws(() => {
    const bad = { ...assertion, signature: b64url(Buffer.concat([Buffer.from([0]), Buffer.from(assertion.signature, 'base64url').subarray(1)])) };
    return verifyWebAuthnAuthorization(req, bad, { publicKey: pubPem });
  }));
  check('WebAuthn: wrong registered key → reject', await throws(() => {
    const otherPub = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' });
    return verifyWebAuthnAuthorization(req, assertion, { publicKey: otherPub });
  }, /signature verification failed/));
}

// ── Request binding + freshness helpers ───────────────────────────────────────
check('request: hashes are deduped + sorted (order-independent binding)', (() => {
  const r = buildAuthorizationRequest('o', [HASHES[1], HASHES[0], HASHES[1]], { nonce: 'x' });
  return r.safeTxHashes.length === 2 && r.safeTxHashes[0] < r.safeTxHashes[1];
})());
check('request: missing nonce → throws', await throws(() => buildAuthorizationRequest('o', HASHES, {}), /nonce required/));
check('request: empty batch → throws', await throws(() => buildAuthorizationRequest('o', [], { nonce: 'x' }), /at least one/));

// ── The composed gate: makeAuthorizer (what approveAll calls) ─────────────────
const deviceFor = (op) => ({
  'hw@corp.com':  { type: 'hw-wallet', address: wallet.address },
  'key@corp.com': { type: 'webauthn',  publicKey: pubPem },
}[op] || null);

{
  const store = memoryNonceStore();
  const authorize = makeAuthorizer(deviceFor, { nonceStore: store });

  const req = buildAuthorizationRequest('hw@corp.com', HASHES, { nonce: 'g1' });
  const proof = { type: 'hw-wallet', request: req, signature: await hwProof(req) };

  check('gate: no proof → throws (2FA required)',
    await throws(() => authorize('hw@corp.com', HASHES, null), /2FA proof/));
  check('gate: proof operator != session operator → throws',
    await throws(() => authorize('ghost@corp.com', HASHES, proof), /does not match the session operator/));
  const ghostReq = buildAuthorizationRequest('ghost@corp.com', HASHES, { nonce: 'g0' });
  const ghostProof = { type: 'hw-wallet', request: ghostReq, signature: await hwProof(ghostReq) };
  check('gate: unregistered operator → throws',
    await throws(() => authorize('ghost@corp.com', HASHES, ghostProof), /no 2FA device registered/));

  // Wallet signs the batch it bound; but here we ask to authorize a DIFFERENT batch.
  check('gate: proof bound to a different batch → throws',
    await throws(() => authorize('hw@corp.com', [HASHES[0]], proof), /exact batch/));

  check('gate: valid hw-wallet proof → ok', (await authorize('hw@corp.com', HASHES, proof)).ok === true);
  check('gate: replay the same nonce → throws', await throws(() => authorize('hw@corp.com', HASHES, proof), /replay/));

  // Device-type mismatch: a webauthn-registered operator presenting an hw-wallet proof.
  const req2 = buildAuthorizationRequest('key@corp.com', HASHES, { nonce: 'g2' });
  const proof2 = { type: 'hw-wallet', request: req2, signature: await hwProof(req2) };
  check('gate: proof type != registered device type → throws',
    await throws(() => authorize('key@corp.com', HASHES, proof2), /not registered for a hardware wallet/));

  // Expired proof.
  const past = Date.now() - 10_000;
  const expiredReq = buildAuthorizationRequest('hw@corp.com', HASHES, { nonce: 'g3', issuedAt: past, ttlMs: 1_000 });
  const expiredProof = { type: 'hw-wallet', request: expiredReq, signature: await hwProof(expiredReq) };
  check('gate: expired proof → throws',
    await throws(() => authorize('hw@corp.com', HASHES, expiredProof), /expired/));

  // WebAuthn path through the gate.
  const wreq = buildAuthorizationRequest('key@corp.com', HASHES, { nonce: 'g4' });
  const wproof = { type: 'webauthn', request: wreq, assertion: webauthnAssertion(wreq) };
  check('gate: valid webauthn proof → ok', (await authorize('key@corp.com', HASHES, wproof)).ok === true);
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
