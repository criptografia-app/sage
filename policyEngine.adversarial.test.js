/**
 * SAGE — Policy Engine adversarial tests (TOKEN-67)
 *
 * Companion to policyEngine.test.js (PR #1), which pins the HAPPY-PATH policy
 * semantics: correct-shaped context in, right decision out. This suite assumes
 * the opposite — that `context` is attacker-shaped — and pins the invariant PR#1
 * does not state:
 *
 *   FAIL CLOSED. An input the engine cannot positively verify must land on
 *   HOLD_HUMAN (or REJECT). It must never buy an AUTO_SIGN.
 *
 * That invariant is the point of the file. Each test below corresponds to an
 * input that DID auto-sign against the pre-hardening engine — i.e. every one of
 * these is a regression test for a real fail-open, not a hypothetical. If a
 * future refactor flips one back, this suite goes red rather than the wallet
 * quietly signing.
 *
 * Runner + style follow PR #1: built-in `node --test`, no new deps, same
 * withFrozenTime clock stub (the modulo tz form keeps that stub working).
 *
 * NOT covered here, by design: where trusted value_usd/kyc/aml actually come
 * from. That is the pending compliance.js design call (Marco). These tests pin
 * how the engine behaves toward an UNTRUSTED caller, which is the posture until
 * that lands.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, normalizePolicy, DECISION } from './policyEngine.js';

// ── Time control (same shape as policyEngine.test.js) ───────────────────────
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

// Wed (day 3), UTC 15 → BRT 12: mid-window, so the clock never masks the input
// under test. Every case here would auto-sign if the field were well-formed —
// that is what makes a HOLD meaningful rather than incidental.
const IN_WINDOW = { utcHour: 15, day: 3 };

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

/** The core assertion of this file. */
function assertNotAutoSign(ctx, label, role) {
  const { decision, reasons } = evalIn(ctx, role);
  assert.notEqual(
    decision, DECISION.AUTO_SIGN,
    `${label} must not auto-sign (got ${decision}: ${reasons.join('; ')})`,
  );
  return { decision, reasons };
}

/** Build a context with the named key removed rather than set to undefined. */
function without(key, over = {}) {
  const ctx = goodContext(over);
  delete ctx[key];
  return ctx;
}

// ── The invariant, stated once over the whole malformed-input space ─────────
test('INVARIANT: no malformed context field can produce AUTO_SIGN', () => {
  const junk = [undefined, null, NaN, Infinity, -Infinity, -1, '', '0', 'true',
                'false', 0, 1, [], {}, () => {}, Symbol.iterator];
  // Values that are legitimately valid for a given field, so they are expected
  // to auto-sign and are not junk there: 0 and 1 are real USD amounts, and
  // is_new_address is a boolean field whose `false` is the whole point.
  const legitimate = { value_usd: [0, 1], is_new_address: [false] };
  // aml_flagged is not in this loop: every truthy value there REJECTs, which is
  // already fail-closed, and is asserted separately below.
  for (const field of ['value_usd', 'kyc_verified', 'aml_clear', 'token', 'is_new_address']) {
    for (const value of junk) {
      if (legitimate[field]?.some(ok => Object.is(ok, value))) continue;
      assertNotAutoSign(goodContext({ [field]: value }), `${field} = ${String(value)}`);
    }
    assertNotAutoSign(without(field), `${field} absent`);
  }
});

// ── value_usd: the money gate ───────────────────────────────────────────────
// Pre-hardening, both limit checks were `context.value_usd > limit`. Any value
// that is not a comparable number makes `>` false, so the transaction sailed
// past BOTH the 10000 human limit and the 3000 auto-sign limit. An omitted
// field auto-signed an unbounded transfer.
test('value_usd: unusable values HOLD instead of passing both limit checks', () => {
  for (const value of [undefined, null, NaN, 'abc', '1,000,000', [], {}, true]) {
    const { reasons } = assertNotAutoSign(goodContext({ value_usd: value }), `value_usd ${String(value)}`);
    assert.match(reasons.join(' '), /not a verified amount/i);
  }
});

test('value_usd: an absent field is not a zero-value transaction', () => {
  const { decision, reasons } = assertNotAutoSign(without('value_usd'), 'value_usd absent');
  assert.equal(decision, DECISION.HOLD_HUMAN);
  assert.match(reasons.join(' '), /not a verified amount/i);
});

test('value_usd: numeric strings are not accepted as amounts', () => {
  // '2000' < 3000 numerically, but string/number confusion is exactly how a
  // "$2000" claim becomes a "$2,000,000" transfer. Demand a real number.
  assertNotAutoSign(goodContext({ value_usd: '2000' }), "value_usd '2000'");
});

test('value_usd: negative amounts HOLD (a negative is not "under the limit")', () => {
  for (const value of [-1, -5000, -Infinity]) {
    assertNotAutoSign(goodContext({ value_usd: value }), `value_usd ${value}`);
  }
});

test('value_usd: Infinity HOLDs on the human limit', () => {
  const { decision } = assertNotAutoSign(goodContext({ value_usd: Infinity }), 'value_usd Infinity');
  assert.equal(decision, DECISION.HOLD_HUMAN);
});

test('value_usd: limit boundaries stay exactly where PR #1 pinned them', () => {
  // Guard against an over-eager "fix" moving > to >= while tightening types.
  assert.equal(evalIn(goodContext({ value_usd: 3000 })).decision, DECISION.AUTO_SIGN);
  assert.equal(evalIn(goodContext({ value_usd: 3000.01 })).decision, DECISION.HOLD_HUMAN);
  assert.equal(evalIn(goodContext({ value_usd: 0 })).decision, DECISION.AUTO_SIGN);
});

// ── kyc / aml: verification booleans ────────────────────────────────────────
// Pre-hardening these were `!context.kyc_verified`, so ANY truthy value passed.
// The string 'no' is truthy. So is {}. So is the string 'false'.
test('kyc_verified: only exactly true is a KYC pass', () => {
  for (const value of ['no', 'false', {}, [], 1, 'true']) {
    const { reasons } = assertNotAutoSign(goodContext({ kyc_verified: value }), `kyc_verified ${String(value)}`);
    assert.match(reasons.join(' '), /KYC not verified/i);
  }
});

test('aml_clear: only exactly true is an AML pass', () => {
  for (const value of ['no', 'false', {}, [], 1]) {
    const { reasons } = assertNotAutoSign(goodContext({ aml_clear: value }), `aml_clear ${String(value)}`);
    assert.match(reasons.join(' '), /AML check not passed/i);
  }
});

test('aml_flagged: any truthy flag REJECTs (fail-closed is safe to honour here)', () => {
  for (const value of [true, 'yes', 1, {}, 'false']) {
    const { decision } = evalIn(goodContext({ aml_flagged: value }));
    assert.equal(decision, DECISION.REJECT, `aml_flagged ${String(value)} should REJECT`);
  }
});

test('aml_flagged: REJECT still outranks every HOLD trigger', () => {
  const { decision } = evalIn(goodContext({
    aml_flagged: true, value_usd: undefined, kyc_verified: 'no', token: null,
  }));
  assert.equal(decision, DECISION.REJECT);
});

// ── is_new_address: the unverified-destination gate ─────────────────────────
// Pre-hardening `if (context.is_new_address && …)` treated "field missing" as
// "address is known and safe" — the caller could clear the gate by staying
// silent. Absence is not evidence.
test('is_new_address: absence is not proof the destination is known', () => {
  const { decision, reasons } = assertNotAutoSign(without('is_new_address'), 'is_new_address absent');
  assert.equal(decision, DECISION.HOLD_HUMAN);
  assert.match(reasons.join(' '), /not verified as previously seen/i);
});

test('is_new_address: only an explicit false clears the gate', () => {
  for (const value of [undefined, null, 0, '', 'false', NaN]) {
    assertNotAutoSign(goodContext({ is_new_address: value }), `is_new_address ${String(value)}`);
  }
  assert.equal(evalIn(goodContext({ is_new_address: false })).decision, DECISION.AUTO_SIGN);
});

// ── token gate ──────────────────────────────────────────────────────────────
// Pre-hardening `if (context.token && !whitelist.includes(...))` skipped the
// whitelist for any falsy token: '', 0, null, or omitted → auto-sign on an
// unidentified asset.
test('token: falsy or absent tokens do not skip the whitelist', () => {
  for (const value of ['', 0, null, undefined, false, NaN]) {
    const { reasons } = assertNotAutoSign(goodContext({ token: value }), `token ${String(value)}`);
    assert.match(reasons.join(' '), /whitelist/i);
  }
  assertNotAutoSign(without('token'), 'token absent');
});

test('token: non-string tokens do not satisfy the whitelist', () => {
  for (const value of [['USDC'], { symbol: 'USDC' }, 1]) {
    assertNotAutoSign(goodContext({ token: value }), `token ${JSON.stringify(value)}`);
  }
});

test('token: whitelist is case-sensitive (documenting current behaviour)', () => {
  // Deliberately conservative: 'usdc' HOLDs. Case-folding would be a widening
  // change, and widening is Marco's call, not a test-driven fix.
  for (const value of ['usdc', 'Usdc', 'USDC ', ' USDC']) {
    assertNotAutoSign(goodContext({ token: value }), `token '${value}'`);
  }
});

test('token: a lookalike symbol is not the whitelisted one', () => {
  for (const value of ['USDCX', 'XUSDC', 'USDС' /* Cyrillic С */]) {
    assertNotAutoSign(goodContext({ token: value }), `token '${value}'`);
  }
});

// ── Context shape ───────────────────────────────────────────────────────────
// Pre-hardening a null/undefined context threw a raw TypeError out of the gate.
// A crashing gate is not a gate: it produces no decision at all, and whether
// that ends up as "held" depends entirely on the caller's error handling.
test('context: null/undefined/non-object HOLD instead of throwing', () => {
  for (const ctx of [null, undefined, 'pwn', 42, true, Symbol('x')]) {
    const { decision, reasons } = evalIn(ctx);
    assert.equal(decision, DECISION.HOLD_HUMAN, `context ${String(ctx)} should HOLD`);
    assert.match(reasons.join(' '), /no verifiable context/i);
  }
});

test('context: an empty object HOLDs (nothing asserted, nothing verified)', () => {
  assertNotAutoSign({}, 'empty context');
});

test('evaluate never throws on hostile input', () => {
  // Labels are literal, never String(ctx) — one of these contexts throws from
  // its own toString, and that would blow up the harness rather than the gate.
  const hostile = [
    // [label, context, assertsNoAutoSign]
    // The last entry carries fully valid claims and only a booby-trapped
    // toString, which evaluate() never calls — auto-signing it is correct, so
    // only the no-throw half applies there.
    ['null', null, true],
    ['undefined', undefined, true],
    ['number', 42, true],
    ['string', 'x', true],
    ['array', [], true],
    ['throwing value_usd getter', { get value_usd() { throw new Error('boom'); } }, true],
    ['throwing kyc getter', { ...goodContext(), get kyc_verified() { throw new Error('boom'); } }, true],
    ['throwing toString', { ...goodContext(), toString() { throw new Error('boom'); } }, false],
  ];
  for (const [label, ctx, assertsNoAutoSign] of hostile) {
    assert.doesNotThrow(() => evalIn(ctx), `context ${label} must not throw`);
    if (assertsNoAutoSign) {
      assert.notEqual(evalIn(ctx).decision, DECISION.AUTO_SIGN, `context ${label} must not auto-sign`);
    }
  }
});

// ── Prototype-sourced claims ────────────────────────────────────────────────
// The gates read plain property access, so an inherited property was
// indistinguishable from an asserted one. Verification claims must be OWN
// properties of the context the caller actually passed.
test('prototype chain: inherited claims do not satisfy the gates', () => {
  const ctx = Object.create({
    kyc_verified: true, aml_clear: true, value_usd: 1, token: 'USDC', is_new_address: false,
  });
  assertNotAutoSign(ctx, 'Object.create-inherited claims');
});

test('prototype pollution: a polluted Object.prototype cannot assert KYC/AML', () => {
  Object.prototype.kyc_verified = true;   // eslint-disable-line no-extend-native
  Object.prototype.aml_clear    = true;   // eslint-disable-line no-extend-native
  try {
    assertNotAutoSign(
      { value_usd: 1000, token: 'USDC', is_new_address: false },
      'polluted Object.prototype',
    );
  } finally {
    delete Object.prototype.kyc_verified;
    delete Object.prototype.aml_clear;
  }
});

test('a null-prototype context still works for legitimate callers', () => {
  const ctx = Object.assign(Object.create(null), goodContext());
  assert.equal(evalIn(ctx).decision, DECISION.AUTO_SIGN);
});

// ── Agent role / capability ─────────────────────────────────────────────────
// Pre-hardening `agentRole` was accepted and never read: 'compliance' — whose
// declared capabilities are check_kyc/check_aml/reject, NOT approve — could
// auto-sign, and so could any string a caller invented.
test('agent role: only a role declaring "approve" can auto-sign', () => {
  assert.equal(evalIn(goodContext(), 'execution').decision, DECISION.AUTO_SIGN);
  // `undefined` is absent here on purpose: it hits the `= 'execution'` default
  // parameter, so it is the authorised default, pinned in the next test.
  for (const role of ['compliance', 'admin', 'root', '', 'toString', '__proto__',
                      'constructor', null, 42, {}, ['execution']]) {
    const { reasons } = assertNotAutoSign(goodContext(), `role ${String(role)}`, role);
    assert.match(reasons.join(' '), /not authorised to approve/i);
  }
});

test('agent role: the default role is the least-privilege one that is declared', () => {
  // evaluate(tx, ctx) with no role → 'execution' (approve). Pinned so the
  // default cannot drift to something unauthorised or, worse, to a skip.
  const { decision } = withFrozenTime(IN_WINDOW.utcHour, IN_WINDOW.day,
    () => evaluate(null, goodContext()));
  assert.equal(decision, DECISION.AUTO_SIGN);
});

// ── Time gates ──────────────────────────────────────────────────────────────
test('tz underflow: UTC 00–02 now renders BRT 21–23, not a negative hour', () => {
  // PR #1 asserted only the DECISION here (it had to stay agnostic to whether
  // the modulo fix had landed). The fix is in, so pin the hour too — a negative
  // hour is the fingerprint of the underflow returning.
  for (const [utcHour, brt] of [[0, 21], [1, 22], [2, 23], [3, 0]]) {
    const { decision, reasons } = withFrozenTime(utcHour, 3, () => evaluate(null, goodContext()));
    assert.equal(decision, DECISION.HOLD_HUMAN, `UTC ${utcHour} should HOLD`);
    assert.match(reasons.join(' '), new RegExp(`\\(${brt}h BRT`), `UTC ${utcHour} → BRT ${brt}`);
    assert.doesNotMatch(reasons.join(' '), /-\d+h BRT/, 'no negative BRT hour');
  }
});

test('hours: every hour outside [9,18) BRT HOLDs, all 24 checked', () => {
  for (let utcHour = 0; utcHour < 24; utcHour++) {
    const brt = ((utcHour - 3) + 24) % 24;
    const inWindow = brt >= 9 && brt < 18;
    const { decision } = withFrozenTime(utcHour, 3, () => evaluate(null, goodContext()));
    assert.equal(
      decision, inWindow ? DECISION.AUTO_SIGN : DECISION.HOLD_HUMAN,
      `UTC ${utcHour} (BRT ${brt}) expected ${inWindow ? 'AUTO_SIGN' : 'HOLD_HUMAN'}`,
    );
  }
});

test('days: the full week, only Mon–Fri inside the window auto-signs', () => {
  for (let day = 0; day <= 6; day++) {
    const weekday = day >= 1 && day <= 5;
    const { decision } = withFrozenTime(IN_WINDOW.utcHour, day, () => evaluate(null, goodContext()));
    assert.equal(decision, weekday ? DECISION.AUTO_SIGN : DECISION.HOLD_HUMAN, `day ${day}`);
  }
});

test('weekend outranks a perfect context', () => {
  for (const day of [0, 6]) {
    const { decision } = withFrozenTime(IN_WINDOW.utcHour, day, () => evaluate(null, goodContext()));
    assert.equal(decision, DECISION.HOLD_HUMAN, `day ${day}`);
  }
});

// ── auto_sign vs always_human interaction ───────────────────────────────────
// The class of bug that costs money: a value the two rule sets disagree about,
// where the permissive branch wins. always_human must never be softened by
// auto_sign, and the HOLD accumulator must not swallow a later gate.
test('a value between the two limits HOLDs, and says which limit', () => {
  const { decision, reasons } = evalIn(goodContext({ value_usd: 5000 }));
  assert.equal(decision, DECISION.HOLD_HUMAN);
  assert.match(reasons.join(' '), /auto-sign limit/i);
});

test('always_human triggers are reported together, not short-circuited to one', () => {
  const { decision, reasons } = withFrozenTime(brtToUtc(20), 6, () => evaluate(null, goodContext({
    value_usd: 50_000, is_new_address: true,
  })));
  assert.equal(decision, DECISION.HOLD_HUMAN);
  const joined = reasons.join(' ');
  assert.match(joined, /> limit 10000/);
  assert.match(joined, /never seen/i);
  assert.match(joined, /outside operating hours/i);
  assert.ok(reasons.length >= 3, `expected all triggers, got: ${joined}`);
});

test('an always_human trigger is never overridden by satisfied auto_sign conditions', () => {
  // Perfect auto_sign inputs (kyc, aml, small value, good token) must not buy
  // their way past a new destination address.
  const { decision } = evalIn(goodContext({ is_new_address: true, value_usd: 1 }));
  assert.equal(decision, DECISION.HOLD_HUMAN);
});

const brtToUtc = (brtHour) => brtHour + 3;

// ── Policy normalisation ────────────────────────────────────────────────────
// A malformed sage-config.json must not delete a limit. `value > undefined` is
// false, so a config missing max_value_usd silently removed the ceiling.
test('normalizePolicy: missing or mistyped fields fall back to the defaults', () => {
  const p = normalizePolicy({ auto_sign: { max_value_usd: 'lots' }, always_human: {} });
  assert.equal(p.auto_sign.max_value_usd, 3000);
  assert.equal(p.always_human.above_usd, 10000);
  assert.deepEqual(p.auto_sign.allowed_tokens, ['USDT', 'USDC', 'ETH', 'BNB']);
  assert.deepEqual(p.auto_sign.allowed_days, [1, 2, 3, 4, 5]);
  assert.equal(p.auto_sign.allowed_hours.start, 9);
  assert.equal(p.auto_sign.allowed_hours.end, 18);
  assert.equal(p.auto_sign.requires_kyc, true);
  assert.equal(p.auto_sign.requires_aml_clear, true);
});

test('normalizePolicy: junk policy objects yield the full default shape', () => {
  for (const raw of [null, undefined, 42, 'policy', [], {}]) {
    const p = normalizePolicy(raw);
    assert.equal(p.auto_sign.max_value_usd, 3000);
    assert.equal(p.always_human.above_usd, 10000);
    assert.ok(Array.isArray(p.auto_sign.allowed_tokens));
    assert.ok(Array.isArray(p.agent_roles.execution));
  }
});

test('normalizePolicy: legitimate overrides still take effect', () => {
  const p = normalizePolicy({
    auto_sign: { max_value_usd: 500, allowed_tokens: ['USDC'], requires_kyc: false },
    always_human: { above_usd: 1000 },
  });
  assert.equal(p.auto_sign.max_value_usd, 500);
  assert.deepEqual(p.auto_sign.allowed_tokens, ['USDC']);
  assert.equal(p.auto_sign.requires_kyc, false);
  assert.equal(p.always_human.above_usd, 1000);
});

// ── Output contract ─────────────────────────────────────────────────────────
test('every decision carries a non-empty reasons array', () => {
  const contexts = [goodContext(), goodContext({ value_usd: 99_999 }), {}, null,
                    goodContext({ aml_flagged: true }), goodContext({ token: '' })];
  for (const ctx of contexts) {
    const { decision, reasons } = evalIn(ctx);
    assert.ok(Object.values(DECISION).includes(decision), `unknown decision ${decision}`);
    assert.ok(Array.isArray(reasons) && reasons.length > 0, 'reasons must be a non-empty array');
    assert.ok(reasons.every(r => typeof r === 'string'), 'reasons must be strings');
  }
});

test('reasons never interpolate a raw object into the audit trail', () => {
  const { reasons } = evalIn(goodContext({ value_usd: { toString: () => 'PWNED' } }));
  assert.doesNotMatch(reasons.join(' '), /PWNED|\[object/);
});
