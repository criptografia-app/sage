/**
 * SAGE — Policy Engine tests (TOKEN-67)
 *
 * Covers evaluate(tx, context, agentRole) — the gate that decides whether an AI
 * agent auto-signs a real-money Safe transaction or holds for a human.
 *
 * Runner: built-in `node --test` (no new deps). policyEngine.js imports only Node
 * built-ins, so this suite runs without node_modules installed.
 *
 * Asserted against the committed default policy in sage-config.json:
 *   auto_sign.max_value_usd = 3000, always_human.above_usd = 10000,
 *   allowed_tokens = [USDT, USDC, ETH, BNB], allowed_hours = [9, 18) BRT,
 *   allowed_days = Mon–Fri.
 *
 * TIME / TIMEZONE — coordinated with @@Rustacean (TOKEN-67 signing-correctness):
 *   The operating-hours gate reads the wall clock (`new Date()`), so every
 *   hours/days test freezes time by stubbing the global Date (see withFrozenTime).
 *   The auto-sign window is BRT (UTC-3), start-inclusive / end-exclusive: [9, 18),
 *   i.e. 09:00–17:59 BRT auto-signs, 08:xx and 18:xx hold. Rustacean is fixing a
 *   UTC underflow (`getUTCHours() - 3` going negative before 03:00 UTC) →
 *   `((getUTCHours() - 3) + 24) % 24`. That fix is DECISION-INVARIANT: in the
 *   underflow band (UTC 00–02) both the buggy negative hour and the corrected
 *   21–23 are outside [9, 18), so evaluate() returns HOLD either way. To stay
 *   agnostic to whether the fix has landed, the boundary tests below pin UTC hours
 *   >= 3 (where buggy and corrected agree exactly) and assert the corrected BRT
 *   boundary. The underflow-band test asserts only the decision (HOLD), not the
 *   hour string.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, DECISION } from './policyEngine.js';

// ── Time control ────────────────────────────────────────────────────────────
// evaluate() does `const now = new Date()` then reads now.getUTCHours() and
// now.getDay(). Swap the global Date for a subclass with those two methods
// pinned, run fn, always restore. getDay(): 0=Sun … 6=Sat.
function withFrozenTime(utcHour, day, fn) {
  const RealDate = globalThis.Date;
  class FrozenDate extends RealDate {
    getUTCHours() { return utcHour; }
    getDay() { return day; }
  }
  globalThis.Date = FrozenDate;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

// UTC hour that maps to a given BRT hour under the corrected conversion, kept in
// the >= 3 band so buggy and fixed policyEngine.js agree. BRT = (utc - 3).
const brtToUtc = (brtHour) => brtHour + 3; // valid for brtHour in [0, 20]

// A weekday, mid-window instant: Wed (day 3), UTC 15 → BRT 12. Well inside the
// hours/days gate, so non-time tests exercise the value/kyc/aml/token logic
// without the clock interfering.
const IN_WINDOW = { utcHour: 15, day: 3 };

// Context that, at IN_WINDOW, satisfies every auto-sign condition. Override per
// test to flip exactly one input.
function goodContext(over = {}) {
  return {
    kyc_verified: true,
    aml_clear: true,
    aml_flagged: false,
    value_usd: 1000,
    token: 'USDC',
    is_new_address: false,
    ...over,
  };
}

const evalIn = (ctx, role) =>
  withFrozenTime(IN_WINDOW.utcHour, IN_WINDOW.day, () => evaluate(null, ctx, role));

// ── AUTO_SIGN ────────────────────────────────────────────────────────────────
test('AUTO_SIGN when value under limit, kyc ok, aml clear, in hours + allowed day, allowed token', () => {
  const { decision } = evalIn(goodContext());
  assert.equal(decision, DECISION.AUTO_SIGN);
});

test('AUTO_SIGN holds across every whitelisted token', () => {
  for (const token of ['USDT', 'USDC', 'ETH', 'BNB']) {
    const { decision } = evalIn(goodContext({ token }));
    assert.equal(decision, DECISION.AUTO_SIGN, `token ${token} should auto-sign`);
  }
});

// CORRECTED BY TOKEN-67/policy-hardening (was: "AUTO_SIGN when token is absent
// (token gate only trips on a set value)"). That assertion pinned a fail-open
// BYPASS as intended behaviour: the old `if (context.token && …)` guarded the
// allowlist behind a truthiness check, so omitting the key skipped the allowlist
// entirely and fell through to auto-sign on an unidentified asset — omit one
// field, bypass one gate, the same class PR #2 was opened to close. An
// unverified token is a HOLD, not a pass. Reviewed and confirmed as a bug (not
// deliberate policy) with @@Architect before inverting.
// See policyEngine.adversarial.test.js → "token: falsy or absent tokens…".
test('HOLD when token is absent from context (an unidentified asset is not whitelisted)', () => {
  const ctx = goodContext();
  delete ctx.token;
  const { decision, reasons } = evalIn(ctx);
  assert.equal(decision, DECISION.HOLD_HUMAN);
  assert.match(reasons.join(' '), /whitelist/i);
});

// ── REJECT (hard, short-circuits first) ──────────────────────────────────────
test('REJECT when aml_flagged', () => {
  const { decision, reasons } = evalIn(goodContext({ aml_flagged: true }));
  assert.equal(decision, DECISION.REJECT);
  assert.match(reasons.join(' '), /AML/i);
});

test('REJECT short-circuits ahead of every HOLD trigger', () => {
  // Otherwise this context screams HOLD (huge value, new address, no kyc/aml,
  // bad token) — aml_flagged must still win and REJECT.
  const ctx = goodContext({
    aml_flagged: true,
    value_usd: 999_999,
    is_new_address: true,
    kyc_verified: false,
    aml_clear: false,
    token: 'DOGE',
  });
  const { decision } = withFrozenTime(brtToUtc(3), 0, () => evaluate(null, ctx)); // also outside hours + Sunday
  assert.equal(decision, DECISION.REJECT);
});

// ── HOLD_HUMAN ───────────────────────────────────────────────────────────────
test('HOLD when value_usd exceeds always_human.above_usd (10000)', () => {
  const { decision, reasons } = evalIn(goodContext({ value_usd: 15_000 }));
  assert.equal(decision, DECISION.HOLD_HUMAN);
  assert.match(reasons.join(' '), /10000/);
});

test('HOLD when destination is a new address', () => {
  const { decision, reasons } = evalIn(goodContext({ is_new_address: true }));
  assert.equal(decision, DECISION.HOLD_HUMAN);
  assert.match(reasons.join(' '), /never seen/i);
});

test('HOLD when value is between the auto-sign limit and the human limit (3000 < v <= 10000)', () => {
  const { decision, reasons } = evalIn(goodContext({ value_usd: 5000 }));
  assert.equal(decision, DECISION.HOLD_HUMAN);
  assert.match(reasons.join(' '), /auto-sign limit/i);
});

test('HOLD when KYC not verified', () => {
  const { decision, reasons } = evalIn(goodContext({ kyc_verified: false }));
  assert.equal(decision, DECISION.HOLD_HUMAN);
  assert.match(reasons.join(' '), /KYC/i);
});

test('HOLD when AML not cleared', () => {
  const { decision, reasons } = evalIn(goodContext({ aml_clear: false }));
  assert.equal(decision, DECISION.HOLD_HUMAN);
  assert.match(reasons.join(' '), /AML/i);
});

test('HOLD when token is not on the auto-sign whitelist', () => {
  const { decision, reasons } = evalIn(goodContext({ token: 'DOGE' }));
  assert.equal(decision, DECISION.HOLD_HUMAN);
  assert.match(reasons.join(' '), /whitelist/i);
});

// ── Operating-hours boundary (BRT window [9, 18), start-inclusive/end-exclusive)
test('hours boundary: 09:00 BRT (start, inclusive) auto-signs', () => {
  const { decision } = withFrozenTime(brtToUtc(9), 3, () => evaluate(null, goodContext()));
  assert.equal(decision, DECISION.AUTO_SIGN);
});

test('hours boundary: 08:00 BRT (one hour before start) holds', () => {
  const { decision, reasons } = withFrozenTime(brtToUtc(8), 3, () => evaluate(null, goodContext()));
  assert.equal(decision, DECISION.HOLD_HUMAN);
  assert.match(reasons.join(' '), /outside operating hours/i);
});

test('hours boundary: 17:00 BRT (last hour inside) auto-signs', () => {
  const { decision } = withFrozenTime(brtToUtc(17), 3, () => evaluate(null, goodContext()));
  assert.equal(decision, DECISION.AUTO_SIGN);
});

test('hours boundary: 18:00 BRT (end, exclusive) holds', () => {
  const { decision, reasons } = withFrozenTime(brtToUtc(18), 3, () => evaluate(null, goodContext()));
  assert.equal(decision, DECISION.HOLD_HUMAN);
  assert.match(reasons.join(' '), /outside operating hours/i);
});

test('timezone underflow band (UTC 00–02 → BRT 21–23) holds regardless of the fix', () => {
  // Rustacean's underflow fix is decision-invariant here: buggy negative hour and
  // corrected 21–23 are both outside [9, 18). Assert the decision only, not the
  // hour rendered into the reason string.
  for (const utcHour of [0, 1, 2]) {
    const { decision } = withFrozenTime(utcHour, 3, () => evaluate(null, goodContext()));
    assert.equal(decision, DECISION.HOLD_HUMAN, `UTC ${utcHour}:00 should HOLD`);
  }
});

// ── Allowed-days boundary (Mon–Fri = getDay 1–5) ─────────────────────────────
test('days boundary: Monday (1) and Friday (5) are inside the allowed window', () => {
  for (const day of [1, 5]) {
    const { decision } = withFrozenTime(IN_WINDOW.utcHour, day, () => evaluate(null, goodContext()));
    assert.equal(decision, DECISION.AUTO_SIGN, `day ${day} should auto-sign`);
  }
});

test('days boundary: Saturday (6) and Sunday (0) hold', () => {
  for (const day of [6, 0]) {
    const { decision, reasons } = withFrozenTime(IN_WINDOW.utcHour, day, () => evaluate(null, goodContext()));
    assert.equal(decision, DECISION.HOLD_HUMAN, `day ${day} should hold`);
    assert.match(reasons.join(' '), /outside operating hours/i);
  }
});
