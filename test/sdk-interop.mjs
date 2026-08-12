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
 * real SAGEClient — deliberately no network, no keys, no funds, so it runs in CI
 * forever. A network/deployment error is a PASS: it proves we got past module
 * loading into real SDK code. Only an interop TypeError is a FAIL.
 *
 * Run: node test/sdk-interop.mjs
 */
import { ethers } from 'ethers';
import { SAGEClient } from '../safeClient.js';
import SafeApiKitNS from '@safe-global/api-kit';
import SafeNS from '@safe-global/protocol-kit';

let failures = 0;
// `detail` explains a result; `always` shows it even on PASS (useful when the
// detail is the observed downstream error rather than a diagnosis).
const check = (name, cond, detail = '', always = true) => {
  const show = detail && (always || !cond);
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${show ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

// An interop failure surfaces as a TypeError about something not being a
// function/constructor. Anything else means the SDK loaded and ran.
const isInteropError = (e) =>
  e instanceof TypeError &&
  /is not a (function|constructor)|undefined is not/i.test(e.message);

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

// ── 3. _protocolKit() must get past module loading ───────────────────────────
// THE regression assertion. Pre-fix this threw `Safe.init is not a function`.
// We do not require the network to succeed — only that we reach real SDK code.
const wallet = ethers.Wallet.createRandom();
let reachedSdk = false, detail = '';
try {
  await client._protocolKit(wallet);
  reachedSdk = true;
  detail = 'init() resolved';
} catch (e) {
  reachedSdk = !isInteropError(e);
  detail = `${e.constructor.name}: ${e.message.split('\n')[0].slice(0, 90)}`;
}
check('_protocolKit() loads protocol-kit (no interop TypeError)', reachedSdk, detail);

// ── 4. The write path must not be dead on arrival ────────────────────────────
// signTransaction/proposeTransaction are what sage.js exposes as sage_approve and
// sage_propose. Both funnel through _protocolKit, and both were dead. Assert
// neither dies on interop — the read path (apiKit) never had this exposure.
for (const [name, invoke] of [
  ['proposeTransaction', () => client.proposeTransaction({ to: wallet.address, value: '0' }, wallet)],
  ['signTransaction',    () => client.signTransaction('0x' + '11'.repeat(32), wallet)],
]) {
  let ok = false, d = '';
  try { await invoke(); ok = true; d = 'no throw'; }
  catch (e) { ok = !isInteropError(e); d = `${e.constructor.name}: ${e.message.split('\n')[0].slice(0, 70)}`; }
  check(`${name}() is not dead on arrival`, ok, d);
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
