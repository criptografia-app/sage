/**
 * Offline unit tests for the SAGE policy engine decision table (policyEngine.js).
 *
 * The policy engine is the security gate: AUTO_SIGN vs HOLD_HUMAN vs REJECT for a
 * pending Safe tx. It had a live clock bug (TOKEN-67 Bug 4: `getUTCHours() - 3`
 * underflowed below 03:00 UTC) yet shipped with no decision-table tests. This
 * suite locks the reject/hold/sign branches and the BRT operating-hours edges.
 *
 * Value-gate fail-closed behaviour is covered separately in
 * test/policy-value-failclosed.mjs; here every case supplies a known value_usd so
 * the branch under test is the ONLY thing that can move the decision.
 *
 * The clock is pinned by running each case under a frozen `global.Date` whose
 * getUTCHours()/getDay() are fixed. That is deliberately the engine-agnostic
 * seam: evaluate() reads the wall clock via `new Date()`, so this works whether
 * or not the engine also supports a `context.now` override — the test stays valid
 * against the committed engine, not just an in-flight one. Freezing the instance
 * (not the wall time) also makes it fully timezone-independent — getDay() is
 * otherwise machine-local and would flake across hosts.
 *
 * Run: node test/policy-engine.mjs   (or `npm test`)
 */
import { evaluate, DECISION } from '../policyEngine.js';

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

/**
 * Run `fn` with `new Date()` frozen so getUTCHours()/getDay() return the given
 * values — the exact seams evaluate() reads. Restores the real Date afterwards.
 */
function at(utcHours, day, fn) {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    getUTCHours() { return utcHours; }
    getDay()      { return day; }
  }
  global.Date = FrozenDate;
  try { return fn(); } finally { global.Date = RealDate; }
}

// Wednesday (day 3), 15:00 UTC → 12:00 BRT — inside the window (hours [9,18),
// days Mon–Fri). The "everything is fine" base with a known, small value.
const clearCtx = {
  aml_flagged:    false,
  value_usd:      1000,
  is_new_address: false,
  kyc_verified:   true,
  aml_clear:      true,
  token:          'USDC',
};

// Everything below the clock section runs at 15:00 UTC / Wednesday (in-window),
// so the field under test is the only thing that can move the decision.
const inWindow = fn => at(15, 3, fn);

// ── Happy path ────────────────────────────────────────────────────────────────
inWindow(() => check('all conditions met inside window → AUTO_SIGN',
  evaluate({}, clearCtx).decision === DECISION.AUTO_SIGN));

// ── Hard reject: AML flag beats everything, even a clear + in-window tx ────────
inWindow(() => check('AML flag → REJECT (overrides an otherwise-clear tx)',
  evaluate({}, { ...clearCtx, aml_flagged: true }).decision === DECISION.REJECT));

// ── always_human triggers → HOLD_HUMAN ────────────────────────────────────────
inWindow(() => {
  const { decision, reasons } = evaluate({}, { ...clearCtx, value_usd: 25000 });
  check('value over always_human limit → HOLD_HUMAN',
    decision === DECISION.HOLD_HUMAN && reasons.some(r => r.includes('25000')));
});
inWindow(() => {
  const { decision, reasons } = evaluate({}, { ...clearCtx, is_new_address: true });
  check('never-seen destination → HOLD_HUMAN',
    decision === DECISION.HOLD_HUMAN && reasons.some(r => r.includes('never seen')));
});

// ── auto_sign gate: over the auto limit but under always_human → HOLD_HUMAN ────
inWindow(() => {
  const { decision, reasons } = evaluate({}, { ...clearCtx, value_usd: 5000 });
  check('over auto-sign limit (but < always_human) → HOLD_HUMAN',
    decision === DECISION.HOLD_HUMAN && reasons.some(r => r.includes('auto-sign limit')));
});
inWindow(() => check('KYC not verified → HOLD_HUMAN',
  evaluate({}, { ...clearCtx, kyc_verified: false }).decision === DECISION.HOLD_HUMAN));
inWindow(() => check('AML not clear → HOLD_HUMAN',
  evaluate({}, { ...clearCtx, aml_clear: false }).decision === DECISION.HOLD_HUMAN));
inWindow(() => {
  const { decision, reasons } = evaluate({}, { ...clearCtx, token: 'SHIB' });
  check('token off the whitelist → HOLD_HUMAN',
    decision === DECISION.HOLD_HUMAN && reasons.some(r => r.includes('SHIB')));
});

// ── Clock: operating days ─────────────────────────────────────────────────────
at(15, 0, () => check('weekend (Sunday) → HOLD_HUMAN',
  evaluate({}, clearCtx).decision === DECISION.HOLD_HUMAN));

// ── Clock: operating-hours edges ──────────────────────────────────────────────
at(3, 3, () => {   // 00:00 BRT, weekday
  const { decision, reasons } = evaluate({}, clearCtx);
  check('before opening hour (00:00 BRT) → HOLD_HUMAN',
    decision === DECISION.HOLD_HUMAN && reasons.some(r => r.includes('outside operating hours')));
});

// TOKEN-67 Bug 4 regression: the pre-dawn UTC underflow. 00:00 UTC → 21:00 BRT.
// The old `getUTCHours() - 3` produced -3 here, so the reported hour was garbage.
// It must now read 21, and still HOLD (21 ∉ [9,18)).
at(0, 3, () => {
  const { decision, reasons } = evaluate({}, clearCtx);
  check('00:00 UTC maps to 21h BRT without underflow (Bug 4 regression)',
    decision === DECISION.HOLD_HUMAN && reasons.some(r => r.includes('21h BRT')));
});

// Boundary: 18:00 BRT is end-exclusive → outside. 21:00 UTC = 18:00 BRT.
at(21, 3, () => check('closing hour is end-exclusive (18:00 BRT) → HOLD_HUMAN',
  evaluate({}, clearCtx).decision === DECISION.HOLD_HUMAN));

// Boundary: 09:00 BRT is start-inclusive → inside. 12:00 UTC = 09:00 BRT.
at(12, 3, () => check('opening hour is start-inclusive (09:00 BRT) → AUTO_SIGN',
  evaluate({}, clearCtx).decision === DECISION.AUTO_SIGN));

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
