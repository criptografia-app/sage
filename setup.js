#!/usr/bin/env node
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
import { createCipheriv, createDecipheriv,
         randomBytes, scryptSync }   from 'crypto';
import { writeFileSync, existsSync } from 'fs';
import { join, dirname }             from 'path';
import { fileURLToPath }             from 'url';
import readline                      from 'readline';

const __dir = dirname(fileURLToPath(import.meta.url));

const SAFE      = '0xe601D7B4103FD508dA521A25D7639F085448196d';
const NETWORK   = 'eip155:137';
const RPC       = 'https://polygon-bor-rpc.publicnode.com';
const THRESHOLD = 2;  // 2-of-3 after adding 2 agents

// ── Minimal ABI for Safe owner management ────────────────────────────────────
const SAFE_ABI = [
  'function addOwnerWithThreshold(address owner, uint256 _threshold)',
  'function changeThreshold(uint256 _threshold)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
];

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
      console.log(`  ✓ ${name} key already exists — skipping`);
      // still need the wallet address for the Safe tx
      const pass = await ask(`  Passphrase for existing "${name}" key: `, true);
      const { decrypt } = await import('./agentKey.js').catch(() => null) || {};
      // fallback: just read address from encrypted file
      passphrases[name] = pass;
      agentWallets[name] = { address: '(existing — run: node sage.js info)' };
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

  // Verify it matches the Safe owner
  const provider   = new ethers.JsonRpcProvider(RPC);
  const ownerSigner = new ethers.Wallet(ownerKey, provider);
  console.log(`\n  Signing address: ${ownerSigner.address}`);

  const safe = new ethers.Contract(SAFE, SAFE_ABI, ownerSigner);
  const currentOwners = await safe.getOwners();
  if (!currentOwners.map(a => a.toLowerCase()).includes(ownerSigner.address.toLowerCase())) {
    console.error(`\n  ✗ ${ownerSigner.address} is NOT an owner of this Safe.`);
    console.error(`  Current owners: ${currentOwners.join(', ')}`);
    process.exit(1);
  }
  console.log(`  ✓ Verified as Safe owner\n`);

  // ── Step 3: Add agent owners ──────────────────────────────────────────────
  console.log('Step 3/4  Adding agents as Safe owners...');

  for (const [i, name] of agents.entries()) {
    const agentAddr = agentWallets[name].address;
    if (agentAddr.startsWith('(existing')) {
      console.log(`  ⚠  ${name}: skipped (existing key — add manually if not already an owner)`);
      continue;
    }

    // For the second agent, threshold stays 1 until we explicitly change it
    // after both are added
    const keepThreshold = 1;
    console.log(`  Adding ${name} (${agentAddr})...`);
    const tx = await safe.addOwnerWithThreshold(agentAddr, keepThreshold, {
      gasLimit: 200_000,
    });
    console.log(`    tx: ${tx.hash}`);
    await tx.wait();
    console.log(`    ✓ confirmed`);
  }

  // ── Step 4: Change threshold to 2-of-3 ───────────────────────────────────
  console.log(`\nStep 4/4  Changing threshold to ${THRESHOLD}-of-3...`);
  const txT = await safe.changeThreshold(THRESHOLD, { gasLimit: 100_000 });
  console.log(`  tx: ${txT.hash}`);
  await txT.wait();
  console.log(`  ✓ confirmed\n`);

  // ── Verify final state ────────────────────────────────────────────────────
  const finalOwners    = await safe.getOwners();
  const finalThreshold = await safe.getThreshold();

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
