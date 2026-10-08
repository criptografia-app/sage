/**
 * Regression test: the policy value gate must FAIL CLOSED (TOKEN-67).
 *
 * WHAT WENT WRONG
 * ---------------
 * evaluate() gated auto-signing on `context.value_usd`, but the trusted context
 * SAGE actually builds (deriveTrustedContext) omits value_usd — there is no
 * price oracle in scope. In JS `undefined > 10000` and `undefined > 3000` are
 * both false, so an unverifiable value silently satisfied EVERY ">" comparison
 * and counted as "under the limit".
 *
 * Today that is masked because kyc_verified is hardcoded false → HOLD_HUMAN.
 * But the value gate is a landmine: the moment KYC/AML are wired true, a
 * transaction whose value we could not establish would sail past both the
 * always-human ceiling AND the auto-sign ceiling straight to AUTO_SIGN — the
 * exact "large transfer slips under a limit" failure this policy exists to stop.
 *
 * WHAT THIS ASSERTS
 * -----------------
 * 1. Unknown value + everything else clear → HOLD_HUMAN (the regression).
 * 2. The happy path still works: a known, under-limit, fully-cleared tx →
 *    AUTO_SIGN. So the fix holds on *unknown* value, not on *all* value.
 * 3. A known over-limit value still holds; value 0 is a known value (auto-signs);
 *    NaN/negative fail closed.
 *
 * The clock is pinned via context.now to a weekday inside operating hours, so
 * the value gate is the only thing under test. No network, keys or funds.
 *
 * Run: node test/policy-value-failclosed.mjs   (or `npm test`)
 */
import { evaluate, DECISION } from '../policyEngine.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  const show = detail && !cond;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${show ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

// Wednesday 2025-06-11 15:00 UTC → 12h BRT (inside 9–18) and a weekday in every
// real timezone (local day lands Tue–Thu). Isolates the value gate.
const MIDDAY_WEEKDAY = new Date('2025-06-11T15:00:00Z');

const base = {
  now:          MIDDAY_WEEKDAY,
  kyc_verified: true,
  aml_clear:    true,
  is_new_address: false,
};

// ── 1. THE regression: unknown value must not auto-sign ──────────────────────
{
  const { decision, reasons } = evaluate({}, { ...base /* value_usd absent */ });
  check(
    'unknown value holds for a human even when KYC+AML are clear',
    decision === DECISION.HOLD_HUMAN,
    `decision=${decision} reasons=${JSON.stringify(reasons)}`,
  );
  check(
    'the hold reason names the unverifiable value',
    reasons.some(r => /could not be verified/i.test(r)),
    JSON.stringify(reasons),
  );
}

// ── 2. Happy path still reaches AUTO_SIGN ────────────────────────────────────
// Guards against the fix over-reaching: fail-closed must trigger on *unknown*
// value, not on every value.
{
  const { decision, reasons } = evaluate({}, { ...base, value_usd: 100 });
  check(
    'a known, under-limit, fully-cleared tx still auto-signs',
    decision === DECISION.AUTO_SIGN,
    `decision=${decision} reasons=${JSON.stringify(reasons)}`,
  );
}

// ── 3. value 0 is a KNOWN value (a contract call carrying no native value) ───
{
  const { decision } = evaluate({}, { ...base, value_usd: 0 });
  check('value_usd 0 is treated as known (not unverifiable)', decision === DECISION.AUTO_SIGN);
}

// ── 4. Known over-limit value still holds ────────────────────────────────────
{
  const { decision } = evaluate({}, { ...base, value_usd: 20000 });
  check('a known over-limit value holds for a human', decision === DECISION.HOLD_HUMAN);
}

// ── 5. NaN / negative are not "known" → fail closed ──────────────────────────
for (const bad of [NaN, -1, Infinity]) {
  const { decision } = evaluate({}, { ...base, value_usd: bad });
  check(`value_usd ${bad} fails closed (HOLD_HUMAN)`, decision === DECISION.HOLD_HUMAN);
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
