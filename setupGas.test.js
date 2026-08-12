/**
 * Tests for setup.js's gas preflight pricing.
 *
 * WHY THIS EXISTS
 * ---------------
 * The first version of the preflight checked `balance === 0n` and printed
 * "✓ funded" for ANY non-zero balance. Against the production Safe that meant
 * telling the operator they were funded while they were short by ~0.19 POL —
 * a green signal attesting "non-zero" rather than "enough".
 *
 * That matters more than a normal off-by-one because running out PARTWAY is the
 * worst outcome: adding one owner and then failing to afford `changeThreshold`
 * leaves the Safe in an intermediate state (extra owner, threshold never
 * raised).
 *
 * So the pricing is a pure exported function and it is tested in both
 * directions — sufficient AND short — rather than only the one it is expected
 * to report.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceGasPlan, FALLBACK_STEP_GAS, GAS_MARGIN_PCT } from './setup.js';

const GWEI = 1_000_000_000n;

test('flags a shortfall instead of passing any non-zero balance', () => {
  // The exact production case: ~429 gwei, 3 steps, an owner holding 0.0034 POL.
  const r = priceGasPlan({
    unitCost:   429n * GWEI,
    gasPerStep: [{ gas: 117148n }, { gas: 117148n }, { gas: null }],
    balance:    3460118824459981n,           // 0.00346 POL
  });
  assert.equal(r.ok, false, 'a non-zero but insufficient balance must NOT pass');
  assert.ok(r.shortfall > 0n);
  assert.equal(r.required, (429n * GWEI * r.totalGas * GAS_MARGIN_PCT) / 100n);
  assert.equal(r.shortfall, r.required - r.balance);
});

test('passes when the balance genuinely covers the plan', () => {
  const r = priceGasPlan({
    unitCost:   429n * GWEI,
    gasPerStep: [{ gas: 117148n }, { gas: 117148n }, { gas: null }],
    balance:    10n ** 18n,                  // 1 POL
  });
  assert.equal(r.ok, true);
  assert.equal(r.shortfall, 0n);
});

test('unmeasurable steps are still charged for, at the fallback', () => {
  const measured = priceGasPlan({ unitCost: 1n, gasPerStep: [{ gas: 50_000n }], balance: 0n });
  const fallback = priceGasPlan({ unitCost: 1n, gasPerStep: [{ gas: null }],    balance: 0n });

  assert.equal(measured.totalGas, 50_000n);
  assert.equal(fallback.totalGas, FALLBACK_STEP_GAS,
    'a step that cannot be simulated yet must not be priced at zero');
  assert.equal(fallback.estimated, 0);
  assert.equal(fallback.total, 1);
});

test('the safety margin is applied, not just the raw cost', () => {
  const r = priceGasPlan({ unitCost: 1n, gasPerStep: [{ gas: 100n }], balance: 0n });
  assert.equal(r.required, 125n, 'expected raw cost 100 plus the 25% margin');
  // A balance covering the raw cost but not the margin must still fail — the
  // margin exists because the fee moves between preflight and submission.
  assert.equal(priceGasPlan({ unitCost: 1n, gasPerStep: [{ gas: 100n }], balance: 100n }).ok, false);
});

test('a zero balance fails (the original check, still true)', () => {
  const r = priceGasPlan({ unitCost: 1n, gasPerStep: [{ gas: 21_000n }], balance: 0n });
  assert.equal(r.ok, false);
});

test('importing setup.js does not start the wizard', () => {
  // The module guards main() behind a direct-execution check. If that guard
  // regressed, this file would have hung or prompted before reaching here.
  assert.equal(typeof priceGasPlan, 'function');
});
