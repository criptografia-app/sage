// SAGE try page: the policy simulator. Runs policyEngine.js unchanged in the browser.
import { evaluate, normalizePolicy } from './policyEngine.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ── Policy simulator ──────────────────────────────────────────────────────
const WHAT = {
  AUTO_SIGN: 'The signer agent would co-sign on its own. With the proposal agent\'s signature that makes 2 of 3, so it executes.',
  HOLD_HUMAN: 'The agent refuses to sign and waits for you. You approve from your own device, or reject it.',
  REJECT: 'The agent refuses outright. An operator\'s "approve all" can\'t override this.',
};
function simulate() {
  const f = new FormData($('sim-form'));
  const wired = f.get('mode') === 'wired';
  $('fields').classList.toggle('muted', !wired);
  const day = Number(f.get('day')), hour = Math.min(23, Math.max(0, Number(f.get('hour')) || 0));
  // A Monday-to-Sunday week; the engine reads the hour in BRT (UTC-3).
  const now = new Date(Date.UTC(2026, 9, 11 + (day === 0 ? 7 : day), hour + 3, 30));
  const context = wired ? {
    value_usd: Number(f.get('usd')), token: f.get('token'), now,
    is_new_address: !f.get('known'), kyc_verified: !!f.get('kyc'), aml_clear: !!f.get('aml'),
    ...(f.get('flag') ? { aml_flagged: true } : {}),
  } : {
    // Exactly what sage.js derives from a real transaction today.
    kyc_verified: false, aml_clear: false, now,
  };
  const { decision, reasons } = evaluate({}, context, 'execution');
  const badge = $('v-badge');
  badge.textContent = decision;
  badge.className = 'v-badge ' + { AUTO_SIGN: 'v-auto', HOLD_HUMAN: 'v-hold', REJECT: 'v-rej' }[decision];
  $('v-reasons').innerHTML = reasons.map((r) => `<li>${esc(r)}</li>`).join('');
  $('v-what').textContent = WHAT[decision] + (wired ? '' : ' As shipped, SAGE can\'t verify value or compliance, so it holds everything. That is deliberate.');
}

// Arrays and small objects on one line, so the policy reads at a glance.
const compact = (v) => JSON.stringify(v, null, 2).replace(/\[\s+([^\[\]{}]*?)\s+\]/g, (_, x) => '[' + x.replace(/\s*\n\s*/g, ' ') + ']')
  .replace(/\{\s+("start"[^{}]*?)\s+\}/g, (_, x) => '{ ' + x.replace(/\s*\n\s*/g, ' ') + ' }');
const { agent_roles, ...policy } = normalizePolicy({});
$('policy-json').textContent = '// the example policy the engine is using\n' + compact(policy);
$('sim-form').addEventListener('input', simulate);
simulate();
