/**
 * Regression test for the Safe SDK ESM/CJS interop defect (TOKEN-67).
 *
 * WHAT WENT WRONG
 * ---------------
 * @safe-global/protocol-kit and @safe-global/api-kit ship CommonJS with no
 * `exports` map. Under Node ESM, `import Safe from '@safe-global/protocol-kit'`
 * therefore binds the module NAMESPACE OBJECT, not the class:
 *
 *     typeof Safe             → 'object'
 *     typeof Safe.init        → 'undefined'   ← the call site used this
 *     typeof Safe.default.init→ 'function'    ← the real class
 *
 * So `_protocolKit()` threw `TypeError: Safe.init is not a function` on EVERY
 * call, killing both signTransaction() and proposeTransaction() — SAGE's entire
 * write path — before a single network request was made.
 *
 * WHY THE EXISTING SUITE DIDN'T CATCH IT
 * --------------------------------------
 * test/hash-conformance.mjs imports only the NAMED export `generateTypedData`.
 * Named exports resolve fine through cjs-module-lexer; only the DEFAULT import is
 * affected. So it verified the EIP-712 math in isolation and stayed green while
 * every entry point that would have used that math was dead. Offline hash
 * validation is necessary but not sufficient — this test closes that gap.
 *
 * WHAT THIS ASSERTS
 * -----------------
 * That the SDKs actually LOAD and their constructors are callable through the
 * real SAGEClient. No keys and no funds, ever.
 *
 * Split in two deliberately:
 *
 *   PART 1 — OFFLINE, UNCONDITIONAL. Pure module-shape and constructor checks.
 *     These encode the regression itself and must never depend on an endpoint.
 *
 *   PART 2 — NETWORK-DEPENDENT, SKIPPED WHEN UNREACHABLE. Driving the real call
 *     sites needs an RPC. This day began with SAGE's default Sepolia RPC dead, so
 *     a test that goes red when someone else's node is down would get muted — and
 *     a muted test protects nothing. When the RPC can't be reached these SKIP
 *     (not fail); when it is reachable they are strict.
 *
 * In both parts, a network/deployment error is a PASS: it proves execution got
 * past module loading into real SDK code. Only an interop TypeError is a FAIL.
 *
 * Run: node test/sdk-interop.mjs   (or `npm test`, which runs node --test)
 */
import { ethers } from 'ethers';
import { SAGEClient, CHAINS } from '../safeClient.js';
import SafeApiKitNS from '@safe-global/api-kit';
import SafeNS from '@safe-global/protocol-kit';

let failures = 0, skipped = 0;
// `detail` explains a result; `always` shows it even on PASS (useful when the
// detail is the observed downstream error rather than a diagnosis).
const check = (name, cond, detail = '', always = true) => {
  const show = detail && (always || !cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${show ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};
const skip = (name, why) => { console.log(`SKIP  ${name} — ${why}`); skipped++; };

// Is the configured Sepolia RPC actually reachable? Deliberately reads the RPC
// out of CHAINS so this tracks whatever the code will really use. Short timeout:
// this is a liveness probe, not a retry.
async function rpcReachable(url, ms = 4000) {
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal:  AbortSignal.timeout(ms),
    });
    if (!res.ok) return false;
    return Boolean((await res.json())?.result);
  } catch { return false; }
}

// Never let a hung endpoint stall CI: bound anything network-touching.
const withTimeout = (p, ms = 15000) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms).unref?.()),
]);

// An interop failure surfaces as a TypeError about something not being a
// function/constructor. Anything else means the SDK loaded and ran.
const isInteropError = (e) =>
  e instanceof TypeError &&
  /is not a (function|constructor)|undefined is not/i.test(e.message);

// ── PART 1 — offline, unconditional: module shape and constructors ───────────
console.log('— offline assertions (no network) —');

// ── 1. Both packages must expose a callable through the `?? .default` guard ───
// Asserted on BOTH: package.json pins caret ranges, so a minor bump could flip
// either package's module shape silently.
for (const [label, ns, member] of [
  ['protocol-kit', SafeNS,       'init'],
  ['api-kit',      SafeApiKitNS, null],   // api-kit's export is the ctor itself
]) {
  const resolved = ns?.default ?? ns;
  check(
    `${label}: resolves to a constructor`,
    typeof resolved === 'function',
    `typeof=${typeof resolved}`,
  );
  if (member) {
    check(
      `${label}: .${member}() is callable`,
      typeof resolved?.[member] === 'function',
      `typeof=${typeof resolved?.[member]}`,
    );
  }
}

// Guard against the specific historical mistake: using the namespace directly.
check(
  'protocol-kit: a callable class is reachable (namespace or .default)',
  typeof SafeNS === 'function' || typeof SafeNS?.default === 'function',
  'neither the namespace nor .default is callable',
  false,   // only meaningful when it fails
);

// ── 2. The api-kit constructor must actually run inside SAGEClient ───────────
// This is where `new SafeApiKit.default(...)` vs `new SafeApiKit(...)` bites.
let client;
try {
  client = new SAGEClient('sepolia', '0x8Be18f0CDBe72f13Adde1c4711334AAf3C479e53');
  check('SAGEClient constructs (api-kit ctor resolved)', true);
} catch (e) {
  check('SAGEClient constructs (api-kit ctor resolved)', false, e.message);
}
check(
  'SAGEClient.apiKit is a live api-kit instance',
  typeof client?.apiKit?.getTransaction === 'function',
  `getTransaction is ${typeof client?.apiKit?.getTransaction}`,
);

// ── PART 2 — network-dependent: driving the real call sites ──────────────────
// These need an RPC. They SKIP when it's unreachable rather than going red: the
// dead-default-RPC incident that motivated this file is exactly the scenario that
// would otherwise mute the whole test.
const rpc = CHAINS.sepolia.rpc;
const wallet = ethers.Wallet.createRandom();

// ── 4. THE regression assertion — UNCONDITIONAL, and deliberately so ─────────
// This one must NOT be gated on RPC reachability. An interop TypeError is thrown
// before any network I/O, so the buggy and fixed cases stay distinguishable with
// the network down: TypeError => bug, anything else (including a timeout or a
// connection refusal) => we reached real SDK code. Skipping it when the RPC is
// unreachable would let the exact defect this file exists for pass unnoticed
// whenever a node is down — which is the scenario that motivated the split.
// Bounded by a short timeout so a black-holed endpoint can't stall CI.
let reachedSdk = false, detail = '';
try {
  await withTimeout(client._protocolKit(wallet), 8000);
  reachedSdk = true;
  detail = 'init() resolved';
} catch (e) {
  reachedSdk = !isInteropError(e);
  detail = `${e.constructor.name}: ${e.message.split('\n')[0].slice(0, 90)}`;
}
check('_protocolKit() loads protocol-kit (no interop TypeError)', reachedSdk, detail);

// ── PART 2 — network-dependent: the full write-path round trips ──────────────
// These reach the Transaction Service as well as the RPC, so unlike the check
// above they cannot cleanly separate "broken code" from "broken endpoint". They
// SKIP when the RPC is unreachable rather than going red — a test that fails
// because someone else's node is down gets muted, and a muted test protects
// nothing.
console.log(`\n— network-dependent assertions (RPC: ${rpc}) —`);

if (!(await rpcReachable(rpc))) {
  const why = 'Sepolia RPC unreachable — interop assertions above still enforced';
  skip('proposeTransaction() is not dead on arrival', why);
  skip('signTransaction() is not dead on arrival', why);
} else {
  // signTransaction/proposeTransaction are what sage.js exposes as sage_approve
  // and sage_propose. Both funnel through _protocolKit, and both were dead.
  for (const [name, invoke] of [
    ['proposeTransaction', () => client.proposeTransaction({ to: wallet.address, value: '0' }, wallet)],
    ['signTransaction',    () => client.signTransaction('0x' + '11'.repeat(32), wallet)],
  ]) {
    let ok = false, d = '';
    try { await withTimeout(invoke()); ok = true; d = 'no throw'; }
    catch (e) { ok = !isInteropError(e); d = `${e.constructor.name}: ${e.message.split('\n')[0].slice(0, 70)}`; }
    check(`${name}() is not dead on arrival`, ok, d);
  }
}

const summary = failures === 0 ? 'ALL PASSED' : `${failures} FAILED`;
console.log(`\n${summary}${skipped ? ` (${skipped} skipped — network unavailable)` : ''}`);
process.exit(failures === 0 ? 0 : 1);
