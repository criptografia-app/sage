#!/usr/bin/env node
/**
 * SAGE — One-shot setup wizard
 *
 * Generates agent keys, adds them as Safe owners, and raises the threshold so
 * the agents can co-sign.
 *
 * Usage:
 *   node setup.js --dry-run --owner 0xYourOwnerAddress   ← simulate, no key, no gas
 *   node setup.js                                        ← real run (prompts for key)
 *
 * Flags:
 *   --dry-run             Simulate every step via eth_call. Changes nothing, spends
 *                         no gas, and needs NO private key — only --owner.
 *   --owner 0x…           Owner address to simulate as (dry-run only).
 *   --safe 0x…            Override the target Safe.
 *   --threshold N         Target threshold (default 2).
 *   --passphrase-file     Also write passphrases to .sage-passphrases.txt (mode 0600).
 *                         OFF by default — see the note in step 1.
 *
 * WHY THIS WAS REWRITTEN
 * ----------------------
 * The original wizard could never have worked. It called
 * `safe.addOwnerWithThreshold(...)` and `safe.changeThreshold(...)` DIRECTLY from
 * the owner's EOA. Safe owner-management functions carry the `authorized`
 * modifier — they require `msg.sender == address(this)`, i.e. the Safe calling
 * itself through `execTransaction`. Called from an owner EOA they revert GS031.
 *
 * Verified by eth_call against the production Safe, from its real owner:
 *   addOwnerWithThreshold  -> REVERT GS031
 *   changeThreshold        -> REVERT GS031
 *
 * That is why the production Safe is still 1-of-1 with the agents not owners,
 * despite the wizard having been committed: it was never successfully executed.
 *
 * The correct path is to build each owner-management call as a SafeTransaction,
 * sign it, and execute it through the Safe — which is what protocol-kit's
 * createAddOwnerTx / createChangeThresholdTx do. Hence --dry-run: a wizard that
 * has never been run should be simulatable before it is trusted.
 */

import { ethers }                    from 'ethers';
import SafeNS                        from '@safe-global/protocol-kit';
import { createCipheriv, randomBytes, scryptSync } from 'crypto';
import { writeFileSync, existsSync } from 'fs';
import { join, dirname }             from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import readline                      from 'readline';
import { loadAgentSigner }           from './agentKey.js';

// protocol-kit ships CommonJS with no `exports` map, so under Node ESM the
// default import is the module namespace object, not the class. The `??` keeps
// this working if a future build ships a real ESM default export.
const Safe = SafeNS?.default ?? SafeNS;

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Args ──────────────────────────────────────────────────────────────────────
const argv    = process.argv.slice(2);
const flag    = (n) => argv.includes(n);
const value   = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const DRY_RUN   = flag('--dry-run');
const SAFE      = value('--safe', '0xe601D7B4103FD508dA521A25D7639F085448196d');
const THRESHOLD = Number(value('--threshold', '2'));
const RPC       = process.env.POLYGON_RPC || 'https://polygon-bor-rpc.publicnode.com';
const WRITE_PASSPHRASE_FILE = flag('--passphrase-file');
const AGENTS    = ['compliance', 'execution'];

// ── Key encryption (same scheme as agentKey.js) ──────────────────────────────
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
        } else if (ch === '') { process.exit(1); }
        else { input += ch; process.stdin.once('data', handler); }
      });
    } else {
      rl.question(question, ans => { rl.close(); resolve(ans.trim()); });
    }
  });
}

// ── Simulation ────────────────────────────────────────────────────────────────
const EXEC_ABI = new ethers.Interface([
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)',
]);

/**
 * A Safe "pre-validated" signature: r = the owner address, s = 0, v = 1.
 * checkSignatures() accepts it when msg.sender is that owner — so an eth_call
 * with `from: owner` satisfies it. That is what lets --dry-run simulate a real
 * execTransaction WITHOUT any private key.
 */
const preValidatedSig = (owner) =>
  '0x' + owner.slice(2).toLowerCase().padStart(64, '0') + '0'.repeat(64) + '01';

/** Decode a Safe revert into its GS-code / reason string where possible. */
function revertReason(e) {
  const raw = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  if (typeof raw === 'string' && raw.startsWith('0x08c379a0')) {
    try { return ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + raw.slice(10))[0]; }
    catch { /* fall through */ }
  }
  return e?.shortMessage || e?.message?.split('\n')[0] || 'unknown revert';
}

/**
 * Simulate one SafeTransaction through execTransaction. Never sends anything.
 * Also measures the gas it would cost, so the preflight can price the real
 * requirement instead of guessing.
 */
async function simulate(provider, safeTx, owner) {
  const d = safeTx.data;
  const data = EXEC_ABI.encodeFunctionData('execTransaction', [
    d.to, d.value, d.data, d.operation,
    d.safeTxGas, d.baseGas, d.gasPrice, d.gasToken, d.refundReceiver,
    preValidatedSig(owner),
  ]);
  const tx = { to: SAFE, from: owner, data };
  try {
    await provider.call(tx);
  } catch (e) {
    return { ok: false, reason: revertReason(e) };
  }
  let gas = null;
  try { gas = await provider.estimateGas(tx); } catch { /* priced with the fallback */ }
  return { ok: true, gas };
}

// Used for steps that cannot be estimated yet because they only become valid
// after an earlier step lands. Deliberately generous — under-quoting here is
// what produces a half-finished run.
export const FALLBACK_STEP_GAS = 120_000n;

/**
 * Can this account actually pay for the plan?
 *
 * Checking `balance > 0` is not an answer: it attests "non-zero", not "enough".
 * Price the real thing — live fee data x measured gas x step count, plus a
 * margin, because Polygon's base fee moves enough that any fixed threshold is
 * wrong within the hour.
 *
 * Running out PARTWAY is the worst outcome: adding one owner and then failing
 * to afford `changeThreshold` leaves the Safe in an intermediate state.
 */
export const GAS_MARGIN_PCT = 125n;   // +25%

/** Pure pricing half, so the arithmetic can be tested without a chain. */
export function priceGasPlan({ unitCost, gasPerStep, balance, marginPct = GAS_MARGIN_PCT }) {
  const totalGas = gasPerStep.reduce((a, g) => a + (g.gas ?? FALLBACK_STEP_GAS), 0n);
  const required = (unitCost * totalGas * marginPct) / 100n;
  return {
    ok: balance >= required,
    balance, required, unitCost, totalGas,
    shortfall: balance >= required ? 0n : required - balance,
    estimated: gasPerStep.filter(g => g.gas != null).length,
    total:     gasPerStep.length,
  };
}

async function gasPreflight(provider, submitter, gasPerStep) {
  const fee = await provider.getFeeData();
  return priceGasPlan({
    unitCost:   fee.maxFeePerGas ?? fee.gasPrice ?? 0n,
    gasPerStep,
    balance:    await provider.getBalance(submitter),
  });
}

function reportGasPreflight(p) {
  console.log('\n  Gas preflight (the Safe\'s balance is irrelevant — the submitter pays):');
  console.log(`    fee/gas    ${ethers.formatUnits(p.unitCost, 'gwei')} gwei (live)`);
  console.log(`    total gas  ${p.totalGas} across ${p.total} step(s)` +
              (p.estimated < p.total ? ` (${p.total - p.estimated} estimated at ${FALLBACK_STEP_GAS} — not yet simulatable)` : ''));
  console.log(`    required   ${ethers.formatEther(p.required)} native (incl. 25% margin)`);
  console.log(`    balance    ${ethers.formatEther(p.balance)} native`);
  if (p.ok) {
    console.log('    ✓ sufficient');
  } else {
    console.log(`    ✗ SHORT BY ${ethers.formatEther(p.shortfall)} native — fund the submitter before running.`);
    console.log('      Do not start: running out partway leaves the Safe half-configured');
    console.log('      (e.g. an owner added but the threshold never raised).');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log(`║         SAGE — Setup Wizard ${DRY_RUN ? '(DRY RUN)  ' : '           '}     ║`);
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`Safe:      ${SAFE}`);
  console.log(`RPC:       ${RPC}`);
  console.log(`Target:    threshold ${THRESHOLD}`);
  if (DRY_RUN) console.log('Mode:      SIMULATION — nothing is sent, no gas, no key required\n');
  else         console.log('');

  const provider = new ethers.JsonRpcProvider(RPC);

  // Read on-chain reality up front. The whole reason this rewrite exists is that
  // documentation claimed a state the chain did not have.
  const readKit  = await Safe.init({ provider: RPC, safeAddress: SAFE });
  const owners0  = await readKit.getOwners();
  const thresh0  = await readKit.getThreshold();
  console.log(`On-chain now: threshold ${thresh0}, owners (${owners0.length}):`);
  owners0.forEach(o => console.log(`  ${o}`));
  console.log('');

  // ── Step 1: agent keys ─────────────────────────────────────────────────────
  console.log('Step 1/4  Agent keys');
  const agentAddrs  = {};
  const passphrases = {};

  for (const name of AGENTS) {
    const keyFile = join(__dir, `.sage-key-${name}.enc`);
    if (existsSync(keyFile)) {
      // Previously this stored the literal string "(existing — …)" as the
      // address and step 3 then silently skipped the agent, so a re-run did
      // nothing. Decrypt the real address instead.
      const pass = await ask(`  Passphrase for existing "${name}" key: `, true);
      try {
        agentAddrs[name] = loadAgentSigner(name, pass).address;
        console.log(`  ✓ ${name}: ${agentAddrs[name]} (existing key)`);
      } catch (e) {
        console.error(`  ✗ ${name}: could not decrypt existing key — ${e.message}`);
        console.error('    Wrong passphrase, or the key file is corrupt. Aborting rather');
        console.error('    than silently skipping this agent (the old behaviour).');
        process.exit(1);
      }
      continue;
    }

    if (DRY_RUN) {
      // Don't create real keys during a simulation — use a deterministic
      // placeholder so the plan is still fully simulatable.
      agentAddrs[name] = ethers.getAddress(
        '0x' + ethers.id(`sage-dry-run-${name}`).slice(26),
      );
      console.log(`  · ${name}: ${agentAddrs[name]} (placeholder — dry run creates no keys)`);
      continue;
    }

    const wallet     = ethers.Wallet.createRandom();
    const passphrase = `sage-${name}-${randomBytes(12).toString('hex')}`;
    writeFileSync(keyFile, encryptKey(JSON.stringify({
      agentName: name, address: wallet.address,
      privateKey: wallet.privateKey, createdAt: new Date().toISOString(),
    }), passphrase), { mode: 0o600 });
    agentAddrs[name]  = wallet.address;
    passphrases[name] = passphrase;
    console.log(`  ✓ ${name}: ${wallet.address} (new key)`);
  }

  // Passphrases are NOT written to disk by default any more. They unlock the
  // .enc key files sitting in the same directory, so a plaintext file beside
  // them removes the point of encrypting at all — and the old code wrote it
  // unconditionally while .gitignore did not cover it.
  //
  // The old code also had a silent data-loss bug: it skipped writing whenever
  // the file already existed, so a newly generated passphrase was never shown
  // or stored, leaving its .enc file permanently undecryptable. Printing here
  // fixes that too.
  if (Object.keys(passphrases).length) {
    console.log('\n  ┌─ SAVE THESE NOW — they are not stored anywhere ─────────────┐');
    for (const [n, p] of Object.entries(passphrases)) {
      console.log(`  │ SAGE_PASSPHRASE_${n.toUpperCase()}=${p}`);
    }
    console.log('  └─ put them in your password manager, then into .env ─────────┘');

    if (WRITE_PASSPHRASE_FILE) {
      const hintFile = join(__dir, '.sage-passphrases.txt');
      writeFileSync(hintFile, Object.entries(passphrases)
        .map(([n, p]) => `SAGE_PASSPHRASE_${n.toUpperCase()}=${p}`).join('\n') + '\n',
        { mode: 0o600 });
      console.log(`\n  ⚠  Also written in PLAINTEXT to ${hintFile} (mode 0600).`);
      console.log('     Delete it once the values are in your password manager.');
    }
  }
  console.log('');

  // ── Step 2: owner identity ────────────────────────────────────────────────
  console.log('Step 2/4  Safe owner');
  let ownerAddress, signerKey = null;

  if (DRY_RUN) {
    ownerAddress = value('--owner');
    if (!ownerAddress || !ethers.isAddress(ownerAddress)) {
      console.error('  ✗ --dry-run needs --owner 0xYourOwnerAddress (an address, never a key).');
      process.exit(1);
    }
    ownerAddress = ethers.getAddress(ownerAddress);
    console.log(`  Simulating as: ${ownerAddress}`);
  } else {
    console.log('  Your key is NEVER written to disk — used only in memory this run.\n');
    const raw = await ask('  Safe owner private key (0x...): ', true);
    signerKey = raw.startsWith('0x') ? raw : '0x' + raw;
    if (!/^0x[a-fA-F0-9]{64}$/.test(signerKey)) {
      console.error('\n  ✗ Invalid private key format. Must be 0x + 64 hex chars.');
      process.exit(1);
    }
    ownerAddress = new ethers.Wallet(signerKey).address;
    console.log(`\n  Signing address: ${ownerAddress}`);
  }

  if (!owners0.map(a => a.toLowerCase()).includes(ownerAddress.toLowerCase())) {
    console.error(`\n  ✗ ${ownerAddress} is NOT an owner of this Safe.`);
    console.error(`  Current owners: ${owners0.join(', ')}`);
    process.exit(1);
  }
  console.log('  ✓ Verified as Safe owner');

  if (thresh0 > 1) {
    console.log(`\n  ⚠  Threshold is ${thresh0}, so one owner cannot execute alone.`);
    console.log('     This wizard signs with a single key. The transactions below will');
    console.log('     need co-signatures from other owners before they can execute.');
  }
  console.log('');

  // ── Build the plan ────────────────────────────────────────────────────────
  const kit = signerKey
    ? await Safe.init({ provider: RPC, signer: signerKey, safeAddress: SAFE })
    : readKit;

  const alreadyOwner = (a) => owners0.map(x => x.toLowerCase()).includes(a.toLowerCase());
  const toAdd = AGENTS.filter(n => !alreadyOwner(agentAddrs[n]));
  const plan  = [];

  for (const name of toAdd) {
    // Keep the threshold as-is while adding; raise it once at the end. Raising
    // it early would make the *next* add un-executable by this single owner.
    plan.push({
      label: `add owner ${name} (${agentAddrs[name]})`,
      build: () => kit.createAddOwnerTx({ ownerAddress: agentAddrs[name], threshold: Number(thresh0) }),
    });
  }
  const finalOwnerCount = owners0.length + toAdd.length;
  if (Number(thresh0) !== THRESHOLD) {
    plan.push({
      label: `change threshold ${thresh0} → ${THRESHOLD}`,
      build: () => kit.createChangeThresholdTx(THRESHOLD),
      needsOwners: THRESHOLD,
    });
  }

  for (const name of AGENTS) {
    if (alreadyOwner(agentAddrs[name])) console.log(`  · ${name} is already an owner — nothing to do`);
  }
  if (!plan.length) {
    console.log('\n✓ Nothing to do — the Safe already matches the target configuration.\n');
    return;
  }

  // ── Step 3/4: simulate or execute ─────────────────────────────────────────
  if (DRY_RUN) {
    console.log('Step 3/4  Simulating each transaction (eth_call, no state change)\n');
    let failures = 0;
    const gasPerStep = [];

    for (const step of plan) {
      // A step whose precondition isn't met yet may fail at BUILD time
      // (protocol-kit validates locally, e.g. "Threshold cannot exceed owner
      // count") as well as at call time. Both mean the same thing here, so
      // classify them identically rather than letting a build throw abort the
      // whole simulation.
      const blockedUntilEarlierStepsLand =
        step.needsOwners && finalOwnerCount >= step.needsOwners && owners0.length < step.needsOwners;

      let safeTx;
      try {
        safeTx = await step.build();
      } catch (e) {
        const why = e?.message?.split('\n')[0] || 'build failed';
        if (blockedUntilEarlierStepsLand) {
          console.log(`  ~ ${step.label}`);
          console.log(`      not yet valid (${why}) — needs ${step.needsOwners} owners, Safe has ${owners0.length}; becomes valid once the ${toAdd.length} add(s) above land.`);
          gasPerStep.push({ gas: null });   // still has to be paid for
        } else {
          console.log(`  ✗ ${step.label}`);
          console.log(`      CANNOT BUILD: ${why}`);
          failures++;
        }
        continue;
      }

      const res = await simulate(provider, safeTx, ownerAddress);
      if (res.ok) {
        gasPerStep.push({ gas: res.gas ?? null });
        console.log(`  ✓ ${step.label}${res.gas ? `  (${res.gas} gas)` : ''}`);
      } else if (blockedUntilEarlierStepsLand) {
        gasPerStep.push({ gas: null });
        console.log(`  ~ ${step.label}`);
        console.log(`      reverts now (${res.reason}) — needs ${step.needsOwners} owners, Safe has ${owners0.length}; valid once the add(s) above land.`);
      } else {
        console.log(`  ✗ ${step.label}`);
        console.log(`      REVERT: ${res.reason}`);
        failures++;
      }
    }

    console.log('\n  Note: each step is simulated independently against CURRENT chain');
    console.log('  state, so steps that depend on an earlier step landing are marked ~.');

    const pf = await gasPreflight(provider, ownerAddress, gasPerStep);
    reportGasPreflight(pf);
    if (!pf.ok) failures++;

    console.log('\nStep 4/4  Control: the ORIGINAL direct-EOA call path');
    const legacy = new ethers.Interface(['function addOwnerWithThreshold(address owner,uint256 _threshold)']);
    try {
      await provider.call({
        to: SAFE, from: ownerAddress,
        data: legacy.encodeFunctionData('addOwnerWithThreshold', [agentAddrs[AGENTS[0]], 1]),
      });
      console.log('  ?? direct call did NOT revert — unexpected; re-check this Safe\'s version');
    } catch (e) {
      console.log(`  ✓ direct addOwnerWithThreshold reverts as expected: ${revertReason(e)}`);
      console.log('    (GS031 = `authorized` modifier: only the Safe may call this on itself.');
      console.log('     This is exactly what the original wizard did, which is why it never ran.)');
    }

    console.log(`\n${failures ? `✗ ${failures} step(s) would FAIL` : '✓ Plan simulates clean'} — nothing was sent.\n`);
    process.exit(failures ? 1 : 0);
  }

  console.log('Step 3/4  Executing\n');

  // Same preflight as --dry-run. Checking only in the dry run would be its own
  // green-signal bug: the safety check has to guard the path that spends money.
  // Priced conservatively here, since steps that aren't valid yet can't be
  // measured until earlier ones land.
  const livePf = await gasPreflight(provider, ownerAddress, plan.map(() => ({ gas: null })));
  reportGasPreflight(livePf);
  if (!livePf.ok) {
    console.error('\n  ✗ Aborting before the first transaction — see shortfall above.');
    process.exit(1);
  }
  console.log('');

  for (const step of plan) {
    console.log(`  ${step.label}`);
    const safeTx = await step.build();

    // Simulate first: cheaper to find out here than in a reverted tx.
    const pre = await simulate(provider, safeTx, ownerAddress);
    if (!pre.ok) {
      console.error(`    ✗ would revert: ${pre.reason} — aborting before spending gas.`);
      process.exit(1);
    }

    const signed = await kit.signTransaction(safeTx);
    const res    = await kit.executeTransaction(signed);
    const hash   = res.hash ?? res.transactionResponse?.hash;
    console.log(`    tx: ${hash}`);
    await (res.transactionResponse?.wait?.() ?? provider.waitForTransaction(hash));
    console.log('    ✓ confirmed');
  }

  // ── Verify final state from chain, not from assumption ────────────────────
  console.log('\nStep 4/4  Verifying on-chain');
  const finalKit    = await Safe.init({ provider: RPC, safeAddress: SAFE });
  const finalOwners = await finalKit.getOwners();
  const finalThresh = await finalKit.getThreshold();

  console.log(`\nOwners (${finalOwners.length}):`);
  finalOwners.forEach(o => console.log(`  ${o}`));
  console.log(`Threshold: ${finalThresh}-of-${finalOwners.length}`);

  const ok = Number(finalThresh) === THRESHOLD &&
             AGENTS.every(n => finalOwners.map(a => a.toLowerCase()).includes(agentAddrs[n].toLowerCase()));
  if (!ok) {
    console.error('\n✗ Final on-chain state does NOT match the target. Do not assume setup');
    console.error('  succeeded — re-run with --dry-run to see what is still outstanding.');
    process.exit(1);
  }

  console.log('\n✓ Setup complete and verified on-chain.\n');
  console.log('Next steps:');
  console.log('  1. Put the passphrases above into your .env');
  console.log('  2. Fund each agent EOA with a little native token — the Safe holds the');
  console.log('     funds, but whoever submits execTransaction pays its own gas');
  console.log('  3. node sage.js info      ← verify Safe state via API\n');
}

// Only run the wizard when executed directly — importing this module (e.g. from a
// test) must not start it. FALLBACK_STEP_GAS is exported for the same reason.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('\n✗ Setup failed:', e.message); process.exit(1); });
}
