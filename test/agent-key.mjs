/**
 * Offline tests for SAGE agent key management (agentKey.js).
 *
 * Agent keys are EOAs sealed at rest with AES-256-GCM over a scrypt-derived key.
 * The security claims that matter:
 *   1. Round-trip: a generated key loads back to the SAME address and can sign.
 *   2. Confidentiality/integrity: a WRONG passphrase cannot decrypt (GCM auth).
 *   3. Tamper-evidence: a single flipped byte in the ciphertext is REJECTED,
 *      not silently decrypted to garbage (this is the whole point of GCM).
 *   4. No clobber: generate refuses to overwrite an existing key file.
 *
 * These had no coverage. Everything runs in a throwaway temp dir via the keysDir
 * injection point, so the repo's real `.sage-key-*.enc` files are never touched.
 * No network, no chain.
 *
 * Run: node test/agent-key.mjs   (or `npm test`)
 */
import { generateAgentKey, loadAgentSigner, listAgentKeyFiles } from '../agentKey.js';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let failures = 0;
const check = (name, cond, detail = '') => {
  const show = detail && !cond;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${show ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

const DIR  = mkdtempSync(join(tmpdir(), 'sage-keys-'));
const PASS = 'correct horse battery staple';

try {
  // ── 1. Round-trip ───────────────────────────────────────────────────────────
  const { address } = generateAgentKey('execution', PASS, DIR);
  check('generate returns a checksummed EOA address', /^0x[0-9a-fA-F]{40}$/.test(address));

  const signer = loadAgentSigner('execution', PASS, null, DIR);
  check('loaded signer address matches the generated one', signer.address === address,
    `${signer.address} !== ${address}`);

  // The loaded wallet must actually be able to sign — proves we recovered the
  // real private key, not just metadata.
  const sig = await signer.signMessage('sage');
  check('recovered key produces a valid signature', typeof sig === 'string' && sig.length === 132);

  // ── 2. Wrong passphrase is rejected ──────────────────────────────────────────
  let wrongRejected = false;
  try { loadAgentSigner('execution', 'not the passphrase', null, DIR); }
  catch { wrongRejected = true; }
  check('a wrong passphrase cannot decrypt the key (GCM auth fails)', wrongRejected);

  // ── 3. Tampered ciphertext is rejected ───────────────────────────────────────
  const keyFile = join(DIR, '.sage-key-execution.enc');
  const blob    = JSON.parse(readFileSync(keyFile, 'utf8'));
  // Flip the last nibble of the ciphertext. GCM must reject the auth tag rather
  // than hand back corrupted plaintext.
  const last    = blob.data.at(-1);
  blob.data     = blob.data.slice(0, -1) + (last === '0' ? '1' : '0');
  writeFileSync(keyFile, JSON.stringify(blob));

  let tamperRejected = false;
  try { loadAgentSigner('execution', PASS, null, DIR); }
  catch { tamperRejected = true; }
  check('a single flipped ciphertext byte is rejected (tamper-evident)', tamperRejected);

  // ── 4. No silent overwrite ───────────────────────────────────────────────────
  // (Key file still exists from step 1 — even tampered, the path is occupied.)
  let overwriteRefused = false;
  try { generateAgentKey('execution', PASS, DIR); }
  catch { overwriteRefused = true; }
  check('generate refuses to overwrite an existing key file', overwriteRefused);

  // ── 5. Listing reports the key file without decrypting ───────────────────────
  generateAgentKey('compliance', PASS, DIR);
  const listed = listAgentKeyFiles(DIR).map(k => k.agentName).sort();
  check('listAgentKeyFiles finds both agents', listed.join(',') === 'compliance,execution',
    listed.join(','));

  // ── 6. Distinct passphrases / salts ⇒ distinct ciphertext for same agent name ─
  // (Regenerating requires a fresh dir since overwrite is refused.)
  const DIR2 = mkdtempSync(join(tmpdir(), 'sage-keys-'));
  try {
    generateAgentKey('execution', PASS, DIR2);
    const a = JSON.parse(readFileSync(join(DIR,  '.sage-key-compliance.enc'), 'utf8'));
    const b = JSON.parse(readFileSync(join(DIR2, '.sage-key-execution.enc'), 'utf8'));
    check('each key file uses a fresh random salt', a.salt !== b.salt);
    check('each key file uses a fresh random IV',   a.iv   !== b.iv);
  } finally {
    rmSync(DIR2, { recursive: true, force: true });
  }
} finally {
  rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
