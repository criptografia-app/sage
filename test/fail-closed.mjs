/**
 * Fail-closed invariant for SAGE auto-signing (TOKEN-67 Bug 3 follow-up).
 *
 * Until compliance.js and a price oracle are wired, deriveTrustedContext()
 * hard-codes kyc_verified:false / aml_clear:false and omits value_usd. The
 * guarantee this locks in: fed the REAL pending-tx facts, the policy engine
 * NEVER auto-signs — every tx is held for a human co-signature, no matter how
 * benign it looks. A refactor that loosens the engine (e.g. treating a missing
 * value_usd as "under the limit") would break this test loudly instead of
 * silently re-enabling autonomous signing on unverified facts.
 *
 * No network, no keys. deriveTrustedContext is pure over its `details` arg.
 *
 * Run: node test/fail-closed.mjs   (or `npm test`)
 */
import { deriveTrustedContext } from '../sage.js';
import { evaluate, DECISION }   from '../policyEngine.js';

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// Pin the clock inside the auto-sign window (12:00 BRT, Wednesday) by freezing
// `new Date()` — the seam evaluate() reads directly — so the ONLY thing that can
// hold these txs is the fail-closed compliance/value default, not the operating-
// hours guard. If the invariant held merely because it happened to be after
// hours, the test would be worthless. Freezing the wall-clock seam (rather than
// passing context.now) keeps this valid against the committed engine too.
const RealDate = Date;
class InWindowDate extends RealDate {
  getUTCHours() { return 15; }  // 12:00 BRT
  getDay()      { return 3;  }  // Wednesday
}
global.Date = InWindowDate;

// A spread of pending-tx shapes, all of which would look "safe" to a naive gate.
const pendingTxShapes = [
  { name: 'native dust transfer', details: {
      to: '0x2222222222222222222222222222222222222222', value: '1', data: '0x',
      operation: 0, nonce: 1, erc20: null } },
  { name: 'zero-value contract call', details: {
      to: '0x3333333333333333333333333333333333333333', value: '0', data: '0xabcdef',
      operation: 0, nonce: 2, erc20: null } },
  { name: 'small whitelisted ERC-20 transfer', details: {
      to: '0x4444444444444444444444444444444444444444', value: '0', data: '0xa9059cbb',
      operation: 0, nonce: 3,
      erc20: { token_address: '0x4444444444444444444444444444444444444444',
               transfer_to: '0x5555555555555555555555555555555555555555',
               transfer_amount: '1000000' } } },
];

for (const { name, details } of pendingTxShapes) {
  const ctx = deriveTrustedContext(details);
  const { decision } = evaluate(details, ctx, 'execution');
  check(`${name} → not AUTO_SIGN (held for human)`, decision !== DECISION.AUTO_SIGN);
  check(`${name} → HOLD_HUMAN specifically`, decision === DECISION.HOLD_HUMAN);
}

// And the shape of the trusted context itself: compliance flags must default
// to the un-verified side, and value_usd must be absent (never synthesised).
const ctx = deriveTrustedContext(pendingTxShapes[0].details);
check('kyc_verified defaults false',  ctx.kyc_verified === false);
check('aml_clear defaults false',     ctx.aml_clear === false);
check('value_usd is not synthesised', ctx.value_usd === undefined);

global.Date = RealDate;

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
