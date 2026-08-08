/**
 * SAGE — Agent Key Management
 *
 * Each agent owns a private key stored encrypted at rest.
 * Pattern mirrors the existing .wallet_key in the P2P desk.
 *
 * An "agent key" is just a regular EOA — it becomes powerful
 * when added as a Safe owner, not because of the key itself.
 */
import { ethers } from 'ethers';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Encryption (same scrypt params as P2P .wallet_key) ─────────────────────
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, KEY_LEN = 32;

function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
}

function encrypt(data, passphrase) {
  const salt = randomBytes(16);
  const iv   = randomBytes(16);
  const key  = deriveKey(passphrase, salt);
  const ciph = createCipheriv('aes-256-gcm', key, iv);
  const enc  = Buffer.concat([ciph.update(data, 'utf8'), ciph.final()]);
  const tag  = ciph.getAuthTag();
  return JSON.stringify({
    salt: salt.toString('hex'),
    iv:   iv.toString('hex'),
    tag:  tag.toString('hex'),
    data: enc.toString('hex'),
  });
}

function decrypt(blob, passphrase) {
  const { salt, iv, tag, data } = JSON.parse(blob);
  const key  = deriveKey(passphrase, Buffer.from(salt, 'hex'));
  const dech = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  dech.setAuthTag(Buffer.from(tag, 'hex'));
  return dech.update(Buffer.from(data, 'hex')) + dech.final('utf8');
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate a new agent key, encrypt it, and save to disk.
 * @param {string} agentName  e.g. 'compliance' | 'execution'
 * @param {string} passphrase used to encrypt the key at rest
 */
export function generateAgentKey(agentName, passphrase) {
  const wallet  = ethers.Wallet.createRandom();
  const keyFile = join(__dir, `.sage-key-${agentName}.enc`);

  if (existsSync(keyFile)) {
    throw new Error(`Key for agent "${agentName}" already exists at ${keyFile}. Delete it first to regenerate.`);
  }

  const payload = JSON.stringify({
    agentName,
    address:    wallet.address,
    privateKey: wallet.privateKey,
    createdAt:  new Date().toISOString(),
  });

  writeFileSync(keyFile, encrypt(payload, passphrase));
  console.log(`[SAGE] Agent key generated: ${agentName} → ${wallet.address}`);
  console.log(`[SAGE] Saved (encrypted) to: ${keyFile}`);
  return { address: wallet.address };
}

/**
 * Load an agent's signer (ethers.Wallet) from disk.
 * @param {string} agentName
 * @param {string} passphrase
 * @param {ethers.Provider} [provider]
 */
export function loadAgentSigner(agentName, passphrase, provider = null) {
  const keyFile = join(__dir, `.sage-key-${agentName}.enc`);
  if (!existsSync(keyFile)) {
    throw new Error(`No key found for agent "${agentName}". Run: node sage.js keygen ${agentName}`);
  }
  const payload    = JSON.parse(decrypt(readFileSync(keyFile, 'utf8'), passphrase));
  const wallet     = new ethers.Wallet(payload.privateKey, provider);
  return wallet;
}

/**
 * Return all agent addresses registered on disk (no decryption needed).
 */
export function listAgentAddresses() {
  return readdirSync(__dir)
    .filter(f => f.startsWith('.sage-key-') && f.endsWith('.enc'))
    .map(f => {
      const agentName = f.replace('.sage-key-', '').replace('.enc', '');
      return { agentName, keyFile: join(__dir, f) };
    });
}
