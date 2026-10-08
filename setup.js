#!/usr/bin/env node
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
 * SAGE — One-shot setup script
 *
 * Generates agent keys, adds them as Safe owners, and changes
 * threshold to 2-of-3. Run once. Takes ~30 seconds.
 *
 * Usage:
 *   node setup.js
 *
 * You will be prompted for your MetaMask private key (never stored).
 */

import { ethers }                    from 'ethers';
import SafeNS                        from '@safe-global/protocol-kit';
import { createCipheriv, createDecipheriv,
         randomBytes, scryptSync }   from 'crypto';
import { writeFileSync, existsSync } from 'fs';
import { join, dirname }             from 'path';
import { fileURLToPath }             from 'url';
import readline                      from 'readline';
import { loadAgentSigner }           from './agentKey.js';

const __dir = dirname(fileURLToPath(import.meta.url));

// protocol-kit ships CommonJS with no `exports` map, so under Node ESM the
// default import is the module namespace, not the class — reach through
// `.default` when present. Same interop guard as safeClient.js.
const Safe = SafeNS?.default ?? SafeNS;

const SAFE      = '0xe601D7B4103FD508dA521A25D7639F085448196d';
const NETWORK   = 'eip155:137';
const RPC       = 'https://polygon-bor-rpc.publicnode.com';
const THRESHOLD = 2;  // 2-of-3 after adding 2 agents

// NB: Safe owner-management functions (addOwnerWithThreshold / changeThreshold)
// are `authorized` — they require `msg.sender == address(this)` and revert with
// GS031 if called directly by an owner EOA. They must be executed AS A SAFE
// TRANSACTION (execTransaction with owner signatures). protocol-kit builds and
// executes those correctly; a hand-rolled `ethers.Contract(SAFE).addOwner...()`
// call (as this wizard originally did) reverts on-chain every time. That is why
// there is no owner-management ABI here — we go through protocol-kit instead.

// ── Key encryption (same as agentKey.js) ─────────────────────────────────────
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1, KEY_LEN = 32;

function encryptKey(data, passphrase) {
  const salt = randomBytes(16), iv = randomBytes(16);
  const key  = scryptSync(passphrase, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  const ciph = createCipheriv('aes-256-gcm', key, iv);
  const enc  = Buffer.concat([ciph.update(data, 'utf8'), ciph.final()]);
  return JSON.stringify({
    salt: salt.toString('hex'), iv: iv.toString('hex'),
    tag: ciph.getAuthTag().toString('hex'), data: enc.toString('hex'),
  });
}

// ── Prompt helper ─────────────────────────────────────────────────────────────
function ask(question, hidden = false) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    if (hidden) {
      process.stderr.write(question);
      process.stdin.setRawMode?.(true);
      let input = '';
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', function handler(ch) {
        ch = ch.toString();
        if (ch === '\n' || ch === '\r') {
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          process.stdin.removeListener('data', handler);
          process.stderr.write('\n');
          rl.close();
          resolve(input);
        } else if (ch === '') { process.exit(); }
        else { input += ch; process.stdin.once('data', handler); }
      });
    } else {
      rl.question(question, ans => { rl.close(); resolve(ans.trim()); });
    }
  });
}

// ── Main setup ────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║         SAGE — Setup Wizard                 ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`Safe:    ${SAFE}`);
  console.log(`Network: Polygon (${NETWORK})`);
  console.log(`Target:  ${THRESHOLD}-of-3 after adding 2 agents\n`);

  // ── Step 1: Generate agent keys ───────────────────────────────────────────
  console.log('Step 1/4  Generating agent keys...');

  const agents = ['compliance', 'execution'];
  const agentWallets = {};
  const passphrases  = {};

  for (const name of agents) {
    const keyFile = join(__dir, `.sage-key-${name}.enc`);
    if (existsSync(keyFile)) {
      console.log(`  ✓ ${name} key already exists — skipping generation`);
      // We still need the agent's ADDRESS so Step 3 can add it as an owner and
      // Step 4 can complete a half-finished run. The address lives inside the
      // encrypted key, so unlock it with the passphrase the operator supplies.
      // (This is why the wizard is now resumable — the old code stubbed a
      // placeholder address here and then skipped adding the agent entirely.)
      const pass = await ask(`  Passphrase for existing "${name}" key: `, true);
      let signer;
      try {
        signer = loadAgentSigner(name, pass, null, __dir);
      } catch {
        console.error(`\n  ✗ Wrong passphrase for "${name}" — cannot recover its address.`);
        process.exit(1);
      }
      passphrases[name]  = pass;
      agentWallets[name] = { address: signer.address };
      console.log(`    ↳ ${signer.address}`);
      continue;
    }

    const wallet     = ethers.Wallet.createRandom();
    const passphrase = `sage-${name}-${randomBytes(8).toString('hex')}`;
    const payload    = JSON.stringify({
      agentName: name, address: wallet.address,
      privateKey: wallet.privateKey, createdAt: new Date().toISOString(),
    });
    writeFileSync(keyFile, encryptKey(payload, passphrase));
    passphrases[name]  = passphrase;
    agentWallets[name] = wallet;
    console.log(`  ✓ ${name}: ${wallet.address}`);
  }

  // Save passphrases hint file (NOT the private keys)
  const hintFile = join(__dir, '.sage-passphrases.txt');
  if (!existsSync(hintFile)) {
    writeFileSync(hintFile, Object.entries(passphrases)
      .map(([n, p]) => `SAGE_PASSPHRASE_${n.toUpperCase()}=${p}`).join('\n') + '\n');
    console.log(`  ✓ Passphrases saved to .sage-passphrases.txt (add to .env)\n`);
  }

  // ── Step 2: Ask for owner private key (never stored) ──────────────────────
  console.log('Step 2/4  Need your Safe owner key to sign transactions.');
  console.log('  Your key is NEVER written to disk — used only in memory this run.\n');
  const ownerKeyRaw = await ask('  MetaMask private key (0x...): ', true);
  const ownerKey    = ownerKeyRaw.startsWith('0x') ? ownerKeyRaw : '0x' + ownerKeyRaw;

  if (!/^0x[a-fA-F0-9]{64}$/.test(ownerKey)) {
    console.error('\n  ✗ Invalid private key format. Must be 0x + 64 hex chars.');
    process.exit(1);
  }

  // Verify it matches a current Safe owner. `ownerSigner` is provider-less: we
  // only need its address here — protocol-kit does all signing/execution.
  const ownerSigner = new ethers.Wallet(ownerKey);
  console.log(`\n  Signing address: ${ownerSigner.address}`);

  // protocol-kit connected as the owner. It builds owner-management txs as
  // proper Safe transactions and executes them via execTransaction, signing
  // with `ownerKey`. On a 1-of-N Safe the single owner signature executes
  // immediately; once threshold is 2, agents must co-sign (the whole point).
  const protocolKit = await Safe.init({ provider: RPC, signer: ownerKey, safeAddress: SAFE });

  const currentOwners = await protocolKit.getOwners();
  if (!currentOwners.map(a => a.toLowerCase()).includes(ownerSigner.address.toLowerCase())) {
    console.error(`\n  ✗ ${ownerSigner.address} is NOT an owner of this Safe.`);
    console.error(`  Current owners: ${currentOwners.join(', ')}`);
    process.exit(1);
  }
  const startThreshold = await protocolKit.getThreshold();
  if (startThreshold > 1) {
    // With threshold > 1 the owner cannot execute alone: adding owners would
    // need co-signatures this one-shot wizard does not collect. Bail clearly
    // rather than fire txs that sit half-signed.
    console.error(`\n  ✗ Safe threshold is ${startThreshold}-of-${currentOwners.length}.`);
    console.error('  This wizard only works on a 1-of-N Safe (single owner executes alone).');
    console.error('  Add the agents and raise the threshold from the Safe UI instead.');
    process.exit(1);
  }
  console.log(`  ✓ Verified as Safe owner (threshold ${startThreshold}-of-${currentOwners.length})\n`);

  // ── Step 3: Add agent owners ──────────────────────────────────────────────
  console.log('Step 3/4  Adding agents as Safe owners...');

  const ownerSet = new Set(currentOwners.map(a => a.toLowerCase()));
  for (const name of agents) {
    const agentAddr = agentWallets[name].address;
    if (ownerSet.has(agentAddr.toLowerCase())) {
      console.log(`  ✓ ${name} (${agentAddr}) already an owner — skipping`);
      continue;
    }

    // Keep threshold at 1 while adding, so each add still executes with the
    // single owner signature; we raise it to THRESHOLD once both are in.
    console.log(`  Adding ${name} (${agentAddr})...`);
    const addTx = await protocolKit.createAddOwnerTx({ ownerAddress: agentAddr, threshold: 1 });
    const res   = await protocolKit.executeTransaction(addTx);
    console.log(`    tx: ${res.hash}`);
    await res.transactionResponse?.wait();
    ownerSet.add(agentAddr.toLowerCase());
    console.log(`    ✓ confirmed`);
  }

  // ── Step 4: Change threshold to 2-of-3 ───────────────────────────────────
  console.log(`\nStep 4/4  Changing threshold to ${THRESHOLD}-of-3...`);
  const thrTx  = await protocolKit.createChangeThresholdTx(THRESHOLD);
  const thrRes = await protocolKit.executeTransaction(thrTx);
  console.log(`  tx: ${thrRes.hash}`);
  await thrRes.transactionResponse?.wait();
  console.log(`  ✓ confirmed\n`);

  // ── Verify final state ────────────────────────────────────────────────────
  const finalOwners    = await protocolKit.getOwners();
  const finalThreshold = await protocolKit.getThreshold();

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║         SAGE — Setup Complete! ✓            ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`Owners (${finalOwners.length}):`);
  finalOwners.forEach(o => console.log(`  ${o}`));
  console.log(`\nThreshold: ${finalThreshold}-of-${finalOwners.length}`);
  console.log('\nNext steps:');
  console.log('  1. Copy .sage-passphrases.txt values into your .env file');
  console.log('  2. Add .sage-passphrases.txt to .gitignore (already there)');
  console.log('  3. node sage.js pending   ← check for pending transactions');
  console.log('  4. node sage.js info      ← verify Safe state via API\n');
}

main().catch(e => { console.error('\n✗ Setup failed:', e.message); process.exit(1); });
