/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SAGE — the agentic wallet for Safe multisig.
 *  A product of CRIPTOGRAFIA CAPITAL, and the foundation of
 *  CRIPTOGRAFIA PRIVATE (Non-Custodial Agentic Wealth Management).
 *
 *  Copyright (c) 2026 CRIPTOGRAFIA Capital.
 *  Released under the MIT License. Free, sovereign, bring-your-own-key.
 *
 *  NON-CUSTODIAL. CRIPTOGRAFIA Capital never takes custody of your assets.
 *  Funds are held solely by your own Safe multisig smart contract. Agent keys
 *  are yours: encrypted at rest locally, or held in a vault you control. You
 *  can always recover and operate your Safe with no vendor present. This
 *  software creates no custodial relationship.
 *
 *  FAIL-CLOSED BY DESIGN. Agents propose; they do not unilaterally move funds.
 *  Execution requires the Safe's threshold of signatures plus the owner's
 *  authenticated instruction. Any unknown, stale, unverifiable or
 *  out-of-policy fact must resolve to HOLD, never to proceed. Do not modify
 *  this file in a way that weakens that guarantee.
 *
 *  NO WARRANTY; NOT FINANCIAL, LEGAL OR TAX ADVICE. Provided "AS IS", without
 *  warranty of any kind, express or implied. Distributed-ledger transactions
 *  are irreversible and may result in total loss of funds. You are solely
 *  responsible for your own regulatory, KYC/AML, sanctions and tax
 *  obligations. See LICENSE for the full terms.
 * ═══════════════════════════════════════════════════════════════════════════
 */
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
  // Decode the FULL plaintext as one buffer, not `update()+final('utf8')`. The
  // latter runs a separate utf8 decode over the update chunk and the final
  // chunk; a multibyte character straddling that boundary would be corrupted.
  // Today's payload is ASCII JSON so it never bit — but the correct form costs
  // nothing and removes the landmine.
  const out = Buffer.concat([dech.update(Buffer.from(data, 'hex')), dech.final()]);
  return out.toString('utf8');
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate a new agent key, encrypt it, and save to disk.
 * @param {string} agentName  e.g. 'compliance' | 'execution'
 * @param {string} passphrase used to encrypt the key at rest
 * @param {string} [keysDir]  directory to write the key file into (default: module dir).
 *                            Injection point for tests — production always uses __dir.
 */
export function generateAgentKey(agentName, passphrase, keysDir = __dir) {
  const wallet  = ethers.Wallet.createRandom();
  const keyFile = join(keysDir, `.sage-key-${agentName}.enc`);

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
 * @param {string} [keysDir]  directory to read the key file from (default: module dir).
 */
export function loadAgentSigner(agentName, passphrase, provider = null, keysDir = __dir) {
  const keyFile = join(keysDir, `.sage-key-${agentName}.enc`);
  if (!existsSync(keyFile)) {
    throw new Error(`No key found for agent "${agentName}". Run: node sage.js keygen ${agentName}`);
  }
  const payload    = JSON.parse(decrypt(readFileSync(keyFile, 'utf8'), passphrase));
  const wallet     = new ethers.Wallet(payload.privateKey, provider);
  return wallet;
}

/**
 * List the agent key FILES on disk, without decrypting them.
 *
 * NB: this deliberately returns names + file paths, NOT addresses — the address
 * is sealed inside the encrypted payload and is unrecoverable without the
 * passphrase. (The previous name `listAgentAddresses` promised something the
 * function cannot deliver.) To resolve an address, load the signer:
 *   loadAgentSigner(agentName, passphrase).address
 *
 * @param {string} [keysDir]  directory to scan (default: module dir).
 * @returns {{ agentName: string, keyFile: string }[]}
 */
export function listAgentKeyFiles(keysDir = __dir) {
  return readdirSync(keysDir)
    .filter(f => f.startsWith('.sage-key-') && f.endsWith('.enc'))
    .map(f => {
      const agentName = f.replace('.sage-key-', '').replace('.enc', '');
      return { agentName, keyFile: join(keysDir, f) };
    });
}
